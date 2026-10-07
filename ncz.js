/*
 * Jeomatik NCZ Reader
 * Copyright (C) 2026 Erdinç Örsan ÜNAL
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 *
 * JavaScript port, 2026, Egemen Çalıkoğlu. Licensed under GPL-2.0-or-later.
 *
 * Port of ncz_pure.py (platform-independent NCZ binary parser).
 * Usage: parseNCZ(arrayBufferOrUint8Array) -> plain object with the same
 * keys and entity fields as the Python parse_ncz() result dict.
 */
var parseNCZ = (function () {
  'use strict';

  var BLOCK_TYPE_LAYER_TABLE = 6;
  var BLOCK_TYPE_GEOMETRY = 21;
  var BLOCK_TYPE_GEOMETRY_EXTENDED = 22;
  var BLOCK_TYPE_VERSION = 25;
  var BLOCK_TYPE_NAMED_DATA = 28;
  var EXTENDED_HEADER_SIZE = 28;

  var GEOMETRY_MINIMUM_BYTES = {
    1: 87, 2: 39, 3: 74, 4: 120, 5: 94, 6: 95, 7: 113,
    9: 24, 10: 124, 11: 82, 12: 122, 13: 122, 15: 90
  };
  var EXTENDED_HEADER_GEOMETRY_TYPES = {
    1: true, 4: true, 5: true, 6: true, 7: true, 9: true, 10: true, 13: true
  };
  var EMBEDDED_GEOMETRY_CONTAINER_TYPES = {
    0: true, 5: true, 14: true, 48: true, 108: true,
    111: true, 132: true, 150: true, 180: true
  };

  // Same constants as Python: 180.0 / math.pi, math.pi / 180.0,
  // math.degrees() and math.radians().
  var RAD_TO_DEG = 180.0 / Math.PI;
  var DEG_TO_RAD = Math.PI / 180.0;

  // Legacy single-byte decoding: Latin-1 with Turkish overrides.
  var LEGACY_CHARS = (function () {
    var table = new Array(256);
    for (var i = 0; i < 256; i++) table[i] = String.fromCharCode(i);
    table[221] = 'İ'; // İ
    table[222] = 'Ş'; // Ş
    table[208] = 'Ğ'; // Ğ
    table[240] = 'ğ'; // ğ
    table[253] = 'ı'; // ı
    table[254] = 'ş'; // ş
    return table;
  })();

  var hasOwn = Object.prototype.hasOwnProperty;

  // ---- Python semantics helpers -------------------------------------

  // Python float `a % b` (result takes the sign of the divisor).
  function pyMod(a, b) {
    var m = a % b;
    if (m !== 0) {
      if ((b < 0) !== (m < 0)) m += b;
    } else {
      m = b < 0 ? -0 : 0;
    }
    return m;
  }

  // Python round(x, 6): correctly rounded, ties to even.
  function pyRound6(v) {
    var a = Math.abs(v);
    var s = a.toFixed(6);
    // An exact decimal tie at 6 digits only happens when a * 128 is an
    // odd integer; toFixed rounds such ties up, Python rounds to even.
    var t = a * 128;
    if (t < 9007199254740992 && t === Math.floor(t) && t % 2 === 1) {
      var last = s.charCodeAt(s.length - 1) - 48;
      if (last % 2 === 1) {
        s = s.substring(0, s.length - 1) + String.fromCharCode(48 + last - 1);
      }
    }
    var r = Number(s);
    return v < 0 ? -r : r;
  }

  // str.strip('\x00 ')
  function stripNulSpace(s) {
    var start = 0, end = s.length, c;
    while (start < end) {
      c = s.charCodeAt(start);
      if (c !== 0 && c !== 32) break;
      start++;
    }
    while (end > start) {
      c = s.charCodeAt(end - 1);
      if (c !== 0 && c !== 32) break;
      end--;
    }
    return start === 0 && end === s.length ? s : s.substring(start, end);
  }

  // str.rstrip('\x00')
  function rstripNul(s) {
    var end = s.length;
    while (end > 0 && s.charCodeAt(end - 1) === 0) end--;
    return end === s.length ? s : s.substring(0, end);
  }

  // Python str.isspace() for the characters this decoder can produce.
  function isPySpace(c) {
    return (c >= 9 && c <= 13) || (c >= 28 && c <= 32) || c === 133 || c === 160;
  }

  // bool(s.strip())
  function hasNonSpace(s) {
    for (var i = 0; i < s.length; i++) {
      if (!isPySpace(s.charCodeAt(i))) return true;
    }
    return false;
  }

  // all(ord(ch) >= 32 or ch == '\t' for ch in s)
  function allPrintableOrTab(s) {
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (!(c >= 32 || c === 9)) return false;
    }
    return true;
  }

  function isTokenByte(v) {
    return (v >= 48 && v <= 57) || (v >= 65 && v <= 90) ||
      (v >= 97 && v <= 122) || v === 45 || v === 95;
  }

  function isAsciiDigits(s) {
    if (!s.length) return false;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 48 || c > 57) return false;
    }
    return true;
  }

  // ---- Parser -------------------------------------------------------

  function NCZParser(bytes) {
    this.data = bytes;
    this.n = bytes.length;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.layer_names = [];
    this.layer_colors = [];
    this.entities = [];
    this.attribute_tables = [];
    this.version_name = '';
    this.epsg = '';
    this.projection_text = '';
    this.unsupported = {};
  }

  var P = NCZParser.prototype;

  // Byte access with Python indexing semantics (IndexError when out of range).
  P.b = function (i) {
    var n = this.n;
    if (i < 0) i += n;
    if (i < 0 || i >= n) throw new RangeError('NCZ index out of range: ' + i);
    return this.data[i];
  };

  P.parse = function () {
    this.scanBlocks();
    this.finalizeEntities();
    this.attribute_tables = this.extractAttributeTables();
    return this.buildResult();
  };

  P.scanBlocks = function () {
    var d = this.data, n = this.n;
    var cursor = 0;
    while (cursor + 5 < n) {
      var blockSize = this.readUint32(cursor + 1) + 4;
      var totalBlockSize = blockSize + 1;
      if (blockSize < 4 || cursor + totalBlockSize > n) {
        cursor += 1;
        continue;
      }
      var blockType = d[cursor];
      if (blockType === BLOCK_TYPE_VERSION && !this.version_name) {
        this.version_name = this.readLegacyString(cursor + 6, d[cursor + 5]);
      } else if (blockType === BLOCK_TYPE_NAMED_DATA) {
        this.parseNamedDataBlock(cursor, blockSize);
      } else if (blockType === BLOCK_TYPE_LAYER_TABLE) {
        this.parseLayerTable(cursor, blockSize);
      } else if ((blockType === BLOCK_TYPE_GEOMETRY ||
                  blockType === BLOCK_TYPE_GEOMETRY_EXTENDED) && blockSize >= 7) {
        var ext = blockType === BLOCK_TYPE_GEOMETRY_EXTENDED ? EXTENDED_HEADER_SIZE : 0;
        this.parseGeometry(cursor, blockSize, ext);
      } else if (EMBEDDED_GEOMETRY_CONTAINER_TYPES[blockType] === true) {
        this.parseEmbeddedGeometry(cursor, blockSize);
      }
      cursor += totalBlockSize;
    }
  };

  P.parseNamedDataBlock = function (offset, blockSize) {
    var blockEnd = Math.min(this.n, offset + blockSize + 1);
    if (offset + 6 > blockEnd) return;

    var blockName = this.readLegacyString(offset + 6, this.b(offset + 5));
    if (blockName === 'MPROJ' && offset + 22 <= blockEnd) {
      var pcode = this.b(offset + 16);
      var projection = pcode === 1 ? 'Geographic' : pcode === 2 ? '6' : pcode === 3 ? '3' : 'Undefined';
      var dcode = this.b(offset + 17);
      var datum = dcode === 0 ? 'WGS-84' : dcode === 1 ? 'ITRF' : dcode === 4 ? 'ED50' :
        dcode === 254 ? 'ED50-HGK' : 'Undefined';
      this.projection_text = datum + ' / ' + projection + ' / Zone ' + this.b(offset + 21);
    } else if (blockName === 'TILED_XML') {
      this.epsg = this.readEpsg(offset, blockEnd - offset);
    } else if (blockName === 'LEX.ST2' && offset + 21 <= blockEnd) {
      var layerCount = this.b(offset + 20);
      for (var index = 0; index < layerCount; index++) {
        var itemOffset = offset + 79 + index * 256;
        if (itemOffset + 3 > blockEnd) break;
        this.layer_colors.push(toArgb(
          this.b(itemOffset), this.b(itemOffset + 1), this.b(itemOffset + 2)));
      }
    }
  };

  P.parseLayerTable = function (offset, blockSize) {
    var blockEnd = Math.min(this.n, offset + blockSize + 1);
    if (offset + 18 > blockEnd) return;

    var layerCount = this.b(offset + 16) + this.b(offset + 17) * 256;
    for (var index = 0; index < layerCount; index++) {
      var itemOffset = offset + 18 + index * 29;
      if (itemOffset + 29 > blockEnd) break;
      var layerName = this.readLegacyString(itemOffset + 5, this.b(itemOffset + 4));
      if (hasNonSpace(layerName)) this.layer_names.push(layerName);
    }
  };

  P.finalizeEntities = function () {
    var entities = this.entities, i, e;
    var hasSmart = false;
    for (i = 0; i < entities.length; i++) {
      if (entities[i].geometry_kind === 'SmartObject') { hasSmart = true; break; }
    }
    if (hasSmart) {
      var kept = [];
      for (i = 0; i < entities.length; i++) {
        e = entities[i];
        if (!(e.geometry_kind === 'Symbol' && e.layer_code === 0 && e.label_text === 'S0')) {
          kept.push(e);
        }
      }
      this.entities = entities = kept;
    }
    for (i = 0; i < entities.length; i++) {
      e = entities[i];
      if (!e.layer_name) e.layer_name = this.layerName(e.layer_code);
      if (e.color_argb === null) e.color_argb = this.geometryColor(e.layer_code, 0);
    }
  };

  P.buildResult = function () {
    return {
      entities: this.entities,
      attribute_tables: this.attribute_tables,
      layer_names: this.layer_names,
      layer_colors: this.layer_colors,
      version_name: this.version_name,
      epsg: this.epsg,
      projection_text: this.projection_text,
      unsupported_geometry_types: this.unsupported
    };
  };

  P.parseGeometry = function (offset, blockSize, ext) {
    if (blockSize < 7 || offset + 6 >= this.n) return;
    var geometryType = this.data[offset + 6];
    if (hasOwn.call(GEOMETRY_MINIMUM_BYTES, geometryType)) {
      var minimumSize = GEOMETRY_MINIMUM_BYTES[geometryType];
      if (EXTENDED_HEADER_GEOMETRY_TYPES[geometryType] === true) minimumSize += ext;
      if (blockSize + 1 < minimumSize) return;
    }
    switch (geometryType) {
      case 1: this.parsePoint(offset, ext); break;
      case 2: this.parseLine(offset, blockSize); break;
      case 3: this.parseCircle(offset); break;
      case 4: this.parseArc(offset, ext); break;
      case 5: this.parseText(offset, ext); break;
      case 6: this.parseSymbol(offset, blockSize, ext); break;
      case 7: this.parseMultiline(offset, blockSize, ext); break;
      case 9: this.parseCompressedCurve(offset, blockSize, ext); break;
      case 10: this.parseBox(offset, blockSize, ext); break;
      case 11: this.parseMapSheet(offset, blockSize); break;
      case 12: this.parseTriangle(offset, blockSize); break;
      case 13: this.parseBlockReference(offset, blockSize, ext); break;
      case 15: this.parseSmartObject(offset, blockSize); break;
      default:
        this.unsupported[geometryType] = (this.unsupported[geometryType] || 0) + 1;
    }
  };

  P.parseEmbeddedGeometry = function (offset, blockSize) {
    var d = this.data;
    var cursor = offset + 5;
    var end = Math.min(this.n, offset + blockSize);
    while (cursor + 6 < end) {
      var t = d[cursor];
      var isGeometry = t === BLOCK_TYPE_GEOMETRY || t === BLOCK_TYPE_GEOMETRY_EXTENDED;
      if (!isGeometry || d[cursor + 5] !== d[cursor + 6]) {
        cursor += 1;
        continue;
      }
      var innerBlockSize = this.readUint32(cursor + 1) + 4;
      var totalInner = innerBlockSize + 1;
      if (innerBlockSize < 7 || cursor + totalInner > end) {
        cursor += 1;
        continue;
      }
      var ext = t === BLOCK_TYPE_GEOMETRY_EXTENDED ? EXTENDED_HEADER_SIZE : 0;
      this.parseGeometry(cursor, innerBlockSize, ext);
      cursor += totalInner;
    }
  };

  P.parsePoint = function (offset, ext) {
    var layerCode = this.b(offset + 7);
    var rawX = this.f64(offset + 8);
    var rawY = this.f64(offset + 16);
    var z = this.f32(offset + 24);
    if (z === 0) z = this.f32(offset + 28);
    if (!validXY(rawX, rawY)) return;
    var nameLength = this.b(offset + ext + 86);
    this.appendEntity('Point', layerCode, this.b(offset + 37),
      [coordinate(rawX, rawY, z)],
      { name: this.readLegacyString(offset + ext + 87, nameLength) });
  };

  P.parseLine = function (offset, blockSize) {
    var layerCode = this.b(offset + 7);
    var rawX1 = this.f64(offset + 8);
    var rawY1 = this.f64(offset + 16);
    var z1 = this.f32(offset + 24);
    var rawX2 = this.f64(offset + blockSize - 19);
    var rawY2 = this.f64(offset + blockSize - 11);
    var z2 = this.f32(offset + blockSize - 3);
    if (!validXY(rawX1, rawY1) || !validXY(rawX2, rawY2)) return;
    this.appendEntity('Line', layerCode, this.b(offset + 37),
      [coordinate(rawX1, rawY1, z1), coordinate(rawX2, rawY2, z2)]);
  };

  P.parseMultiline = function (offset, blockSize, ext) {
    var layerCode = this.b(offset + 7);
    var textLength = this.b(offset + ext + 86);
    var text = this.readLegacyString(offset + ext + 87, textLength);
    var pointCount = Math.floor((blockSize + 1 - 113 - ext) / 24);
    if (pointCount < 2) return;
    var blockEnd = Math.min(this.n, offset + blockSize + 1);
    var coordinates = [];
    for (var index = 0; index < pointCount; index++) {
      var co = index * 24 + (offset + ext + 113);
      if (co + 24 > blockEnd) break;
      coordinates.push(coordinate(this.f64(co), this.f64(co + 8), this.f64(co + 16)));
    }
    if (coordinates.length < 2) return;
    var isClosed = isNearlyClosed(coordinates);
    if (isClosed && !sameCoordinate(coordinates[0], coordinates[coordinates.length - 1])) {
      var first = coordinates[0];
      coordinates.push({ x: first.x, y: first.y, z: first.z });
    }
    var box = boxMetrics(coordinates);
    this.appendEntity(isClosed ? 'Polygon' : 'Polyline', layerCode, this.b(offset + 37),
      box.coordinates, {
        label_text: text,
        is_closed: isClosed,
        box_width: box.width,
        box_height: box.height,
        rotation_degrees: box.isBox ? box.rotation : 0.0
      });
  };

  P.parseCompressedCurve = function (offset, blockSize, ext) {
    var originX = this.f64(offset + 8);
    var originY = this.f64(offset + 16);
    if (!validXY(originX, originY)) return;
    var pointDataOffset = offset + ext + 122;
    var endOffset = offset + blockSize + 1;
    if (pointDataOffset + 8 > endOffset) return;
    var coordinates = [];
    var invalidStreak = 0;
    for (var ro = pointDataOffset; ro < endOffset - 7; ro += 18) {
      var dx = this.f32(ro);
      var dy = this.f32(ro + 4);
      if (!isFinite(dx) || !isFinite(dy)) {
        invalidStreak += 1;
        if (coordinates.length && invalidStreak >= 4) break;
        continue;
      }
      var x = originX + dx;
      var y = originY + dy;
      if (!validXY(x, y)) {
        invalidStreak += 1;
        if (coordinates.length && invalidStreak >= 4) break;
        continue;
      }
      invalidStreak = 0;
      var coord = coordinate(x, y, 0.0);
      if (coordinates.length) {
        var prev = coordinates[coordinates.length - 1];
        if (Math.abs(prev.x - coord.x) < 0.0001 && Math.abs(prev.y - coord.y) < 0.0001) continue;
      }
      coordinates.push(coord);
    }
    if (coordinates.length < 2) return;
    this.appendEntity('Polyline', this.b(offset + 7), this.b(offset + 37), coordinates);
  };

  P.parseCircle = function (offset) {
    var layerCode = this.b(offset + 7);
    var rawX = this.f64(offset + 8);
    var rawY = this.f64(offset + 16);
    var z = this.f32(offset + 24);
    if (!validXY(rawX, rawY)) return;
    var x2 = this.f64(offset + 50);
    var x3 = this.f64(offset + 66);
    this.appendEntity('Circle', layerCode, this.b(offset + 37),
      [coordinate(rawX, rawY, z)], { radius: Math.abs(x2 - x3) / 2.0 });
  };

  P.parseArc = function (offset, ext) {
    var layerCode = this.b(offset + 7);
    var rawX = this.f64(offset + 8);
    var rawY = this.f64(offset + 16);
    var z = this.f32(offset + 24);
    if (!validXY(rawX, rawY)) return;
    this.appendEntity('Arc', layerCode, this.b(offset + 37),
      [coordinate(rawX, rawY, z)], {
        radius: this.f64(offset + ext + 86),
        start_angle: this.f64(offset + ext + 104),
        end_angle: this.f64(offset + ext + 112)
      });
  };

  P.parseText = function (offset, ext) {
    var layerCode = this.b(offset + 7);
    var rawX = this.f64(offset + 8);
    var rawY = this.f64(offset + 16);
    var z = this.f32(offset + 24);
    if (z === 0) z = this.f32(offset + 28);
    if (!validXY(rawX, rawY)) return;
    var text = this.readTextPayload(offset, ext);
    if (!text) return;
    var textHeight = this.readPositiveFloat(offset + ext + 86);
    if (textHeight === null) textHeight = this.readPositiveFloat(offset + 86);
    if (textHeight === null) return;
    var rotation = pyMod(this.f32(offset + ext + 90) * RAD_TO_DEG, 360.0);
    this.appendEntity('Text', layerCode, this.b(offset + 37),
      [coordinate(rawX, rawY, z)], {
        label_text: text,
        text_height: textHeight,
        rotation_degrees: rotation
      });
  };

  P.parseSymbol = function (offset, blockSize, ext) {
    var layerCode = this.b(offset + 7);
    var rawX = this.f64(offset + 8);
    var rawY = this.f64(offset + 16);
    var z = this.f32(offset + 24);
    if (!validXY(rawX, rawY)) return;
    var blockEnd = Math.min(this.n, offset + blockSize + 1);
    var symbolOffset = offset + ext + 94;
    if (symbolOffset < offset || symbolOffset >= blockEnd) symbolOffset = offset + 94;
    var symbolCode = (symbolOffset >= 0 && symbolOffset < blockEnd) ? this.b(symbolOffset) : 0;
    var symbolSize = this.readPositiveFloat(offset + ext + 86);
    if (symbolSize === null) symbolSize = this.readPositiveFloat(offset + 86);
    if (symbolSize === null) symbolSize = 5.0;
    var rotation = pyMod(this.f32(offset + ext + 90) * RAD_TO_DEG, 360.0);
    this.appendEntity('Symbol', layerCode, this.b(offset + 37),
      [coordinate(rawX, rawY, z)], {
        label_text: 'S' + symbolCode,
        text_height: symbolSize,
        rotation_degrees: rotation
      });
  };

  P.parseBlockReference = function (offset, blockSize, ext) {
    var rawX = this.f64(offset + 8);
    var rawY = this.f64(offset + 16);
    var z = this.f32(offset + 24);
    if (!validXY(rawX, rawY)) return;
    var blockName = this.readLengthPrefixedName(offset + ext + 86, offset + blockSize + 1);
    var rotation = pyMod(this.f32(offset + ext + 118) * RAD_TO_DEG, 360.0);
    this.appendEntity('Block', this.b(offset + 7), this.b(offset + 37),
      [coordinate(rawX, rawY, z)], {
        label_text: blockName,
        rotation_degrees: rotation
      });
  };

  P.parseBox = function (offset, blockSize, ext) {
    var layerCode = this.b(offset + 7);
    var rawX1 = this.f64(offset + 8);
    var rawY1 = this.f64(offset + 16);
    var rawX2 = this.f64(offset + ext + 104);
    var rawY2 = this.f64(offset + ext + 112);
    var rotationRadians = this.f32(offset + ext + 120);
    if (!validXY(rawX1, rawY1) || !validXY(rawX2, rawY2)) return;
    var width = Math.abs(rawX2 - rawX1);
    var height = Math.abs(rawY2 - rawY1);
    var rotation = pyMod(rotationRadians * RAD_TO_DEG, 360.0);
    var angle = rotation * DEG_TO_RAD;
    var sideX = Math.sin(angle);
    var sideY = Math.cos(angle);
    var bottomX = Math.cos(angle);
    var bottomY = -Math.sin(angle);
    var p0x = rawX1, p0y = rawY1;
    var p1x = p0x + bottomX * width, p1y = p0y + bottomY * width;
    var p2x = p1x + sideX * height, p2y = p1y + sideY * height;
    var p3x = p0x + sideX * height, p3y = p0y + sideY * height;
    this.appendEntity('Polygon', layerCode, this.b(offset + 37), [
      coordinate(p0x, p0y, 0.0),
      coordinate(p1x, p1y, 0.0),
      coordinate(p2x, p2y, 0.0),
      coordinate(p3x, p3y, 0.0),
      coordinate(p0x, p0y, 0.0)
    ], {
      is_closed: true,
      box_width: width,
      box_height: height,
      rotation_degrees: rotation,
      label_text: this.readPlanBoxName(offset, blockSize)
    });
  };

  P.parseMapSheet = function (offset, blockSize) {
    var layerCode = this.b(offset + 7);
    var rawX1 = this.f64(offset + 50);
    var rawY1 = this.f64(offset + 58);
    var rawX2 = this.f64(offset + 66);
    var rawY2 = this.f64(offset + 74);
    if (!validXY(rawX1, rawY1) || !validXY(rawX2, rawY2)) return;
    var minX = pyMin(rawX1, rawX2), maxX = pyMax(rawX1, rawX2);
    var minY = pyMin(rawY1, rawY2), maxY = pyMax(rawY1, rawY2);
    if (Math.abs(maxX - minX) < 0.001 || Math.abs(maxY - minY) < 0.001) return;
    var sheetName = this.readLengthPrefixedName(offset + 86, offset + blockSize + 1);
    this.appendEntity('MapSheet', layerCode, this.b(offset + 37), [
      coordinate(minX, minY, 0.0),
      coordinate(maxX, minY, 0.0),
      coordinate(maxX, maxY, 0.0),
      coordinate(minX, maxY, 0.0),
      coordinate(minX, minY, 0.0)
    ], {
      is_closed: true,
      box_width: maxX - minX,
      box_height: maxY - minY,
      label_text: sheetName
    });
  };

  P.parseTriangleVertex = function (offset, xOff, yOff, zOff) {
    var n = this.n;
    if (offset + xOff + 8 > n || offset + yOff + 8 > n) return null;
    var x = this.f64(offset + xOff);
    var y = this.f64(offset + yOff);
    var z = 0.0;
    if (zOff !== undefined && offset + zOff + 4 <= n) z = this.f32(offset + zOff);
    if (!validXY(x, y)) return null;
    return coordinate(x, y, z);
  };

  P.parseTriangle = function (offset, blockSize) {
    var a = this.parseTriangleVertex(offset, 8, 16, 24);
    var b = this.parseTriangleVertex(offset, 86, 94);
    var c = this.parseTriangleVertex(offset, 106, 114);
    if (a === null || b === null || c === null) return;
    var area2 = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
    if (area2 <= 0.0001) return;
    this.appendEntity('Triangle', this.b(offset + 7), this.b(offset + 37), [a, b, c]);
  };

  P.parseSmartObject = function (offset, blockSize) {
    var layerCode = this.b(offset + 7);
    var blockEnd = Math.min(this.n, offset + blockSize + 1);
    var rawX1 = this.f64(offset + 8);
    var rawY1 = this.f64(offset + 16);
    if (!validXY(rawX1, rawY1)) return;
    var width = offset + 177 <= blockEnd ? this.f64(offset + 169) : 0.0;
    var height = offset + 185 <= blockEnd ? this.f64(offset + 177) : 0.0;
    var gridX = offset + 193 <= blockEnd ? this.f64(offset + 185) : 0.0;
    var gridY = offset + 201 <= blockEnd ? this.f64(offset + 193) : 0.0;
    var rawX2 = this.f64(offset + 66);
    var rawY2 = this.f64(offset + 74);
    if (width <= 0.0 || height <= 0.0) {
      if (!validXY(rawX2, rawY2)) return;
      width = Math.abs(rawX2 - rawX1);
      height = Math.abs(rawY2 - rawY1);
    }
    if (width < 0.001 || height < 0.001) return;
    var angleGrads = this.f32(offset + 82);
    var rotation = isFinite(angleGrads) ? pyMod(angleGrads * 0.9, 360.0) : 0.0;
    var scale = this.f32(offset + 86);
    if (!isFinite(scale)) scale = 0.0;
    var angle = rotation * DEG_TO_RAD;
    var bottomX = Math.sin(angle);
    var bottomY = Math.cos(angle);
    var sideX = Math.cos(angle);
    var sideY = -Math.sin(angle);
    var p0x = rawX1, p0y = rawY1;
    var p1x = p0x + bottomX * width, p1y = p0y + bottomY * width;
    var p2x = p1x + sideX * height, p2y = p1y + sideY * height;
    var p3x = p0x + sideX * height, p3y = p0y + sideY * height;
    var label = this.containsAscii(offset, blockEnd, 'BASIC')
      ? 'BASIC'
      : this.readAsciiToken(offset + 145, blockEnd);
    this.appendEntity('SmartObject', layerCode, this.b(offset + 37), [
      coordinate(p0x, p0y, 0.0),
      coordinate(p1x, p1y, 0.0),
      coordinate(p2x, p2y, 0.0),
      coordinate(p3x, p3y, 0.0),
      coordinate(p0x, p0y, 0.0)
    ], {
      is_closed: true,
      box_width: width,
      box_height: height,
      rotation_degrees: rotation,
      scale: scale,
      grid_x: gridX,
      grid_y: gridY,
      label_text: label
    });
  };

  function opt(extra, key, def) {
    return extra && hasOwn.call(extra, key) ? extra[key] : def;
  }

  P.appendEntity = function (kind, layerCode, colorCode, coordinates, extra) {
    this.entities.push({
      geometry_kind: kind,
      layer_code: layerCode,
      layer_name: this.layerName(layerCode),
      color_argb: this.geometryColor(layerCode, colorCode),
      name: opt(extra, 'name', ''),
      label_text: opt(extra, 'label_text', ''),
      text_height: opt(extra, 'text_height', 0.0),
      rotation_degrees: opt(extra, 'rotation_degrees', 0.0),
      box_width: opt(extra, 'box_width', 0.0),
      box_height: opt(extra, 'box_height', 0.0),
      scale: opt(extra, 'scale', 0.0),
      grid_x: opt(extra, 'grid_x', 0.0),
      grid_y: opt(extra, 'grid_y', 0.0),
      radius: opt(extra, 'radius', 0.0),
      start_angle: opt(extra, 'start_angle', 0.0),
      end_angle: opt(extra, 'end_angle', 0.0),
      is_closed: opt(extra, 'is_closed', false),
      coordinates: coordinates
    });
  };

  // ---- Attribute tables ---------------------------------------------

  P.extractAttributeTables = function () {
    var d = this.data, n = this.n;
    var markers = [];
    var cursor = 0;
    while (true) {
      var markerOffset = this.findAscii('@TAB', cursor);
      if (markerOffset < 0) break;
      var endOffset = markerOffset + 4;
      while (endOffset < n && d[endOffset] >= 48 && d[endOffset] <= 57) endOffset += 1;
      var tableRef = this.asciiIgnore(markerOffset, endOffset);
      var recordStart = markerOffset;
      var refLength = endOffset - markerOffset;
      if (markerOffset > 0 && d[markerOffset - 1] === refLength) recordStart = markerOffset - 1;
      markers.push({ record_start: recordStart, table_ref: tableRef });
      cursor = endOffset;
    }
    if (!markers.length) return [];
    var tables = {};
    var order = [];
    for (var index = 0; index < markers.length; index++) {
      var marker = markers[index];
      var nextStart = n;
      if (index + 1 < markers.length) {
        var candidate = markers[index + 1].record_start;
        if (candidate > marker.record_start) nextStart = candidate;
      }
      var recordEnd = Math.min(n, nextStart);
      if (recordEnd <= marker.record_start) continue;
      var rows;
      if (hasOwn.call(tables, marker.table_ref)) {
        rows = tables[marker.table_ref];
      } else {
        rows = tables[marker.table_ref] = [];
        order.push(marker.table_ref);
      }
      rows.push(this.parseAttributeRow(marker.record_start, recordEnd,
        marker.table_ref, rows.length + 1));
    }
    order.sort(function (a, b) { return a < b ? -1 : a > b ? 1 : 0; });
    var result = [];
    for (var k = 0; k < order.length; k++) {
      if (tables[order[k]].length) {
        result.push({ table_ref: order[k], rows: tables[order[k]] });
      }
    }
    return result;
  };

  P.parseAttributeRow = function (rs, re, tableRef, rowIndex) {
    var self = this;
    var d = this.data;
    var L = re - rs;
    var cols = { row_variant: 'unknown', record_length: L };
    var row = { row_index: rowIndex, columns: cols };
    if (L >= 11) cols.table_ref_inline = stripNulSpace(this.asciiIgnore(rs + 1, rs + 11));

    function byteOr0(rel) { return rel < L ? d[rs + rel] : 0; }
    function u16(rel) {
      if (rel < 0 || rel + 2 > L) return 0;
      return d[rs + rel] + d[rs + rel + 1] * 256;
    }
    function u32(rel) {
      if (rel < 0 || rel + 4 > L) return 0;
      var o = rs + rel;
      return d[o] + d[o + 1] * 256 + d[o + 2] * 65536 + d[o + 3] * 16777216;
    }
    function f32(rel) {
      if (rel < 0 || rel + 4 > L) return 0.0;
      return self.view.getFloat32(rs + rel, true);
    }
    function f64(rel) {
      if (rel < 0 || rel + 8 > L) return 0.0;
      return self.view.getFloat64(rs + rel, true);
    }

    var labelLength = L > 28 ? d[rs + 28] : 0;
    var hasLabel = labelLength >= 1 && labelLength <= 64 && 29 + labelLength <= L;
    var labelText = '';
    if (hasLabel) {
      var printable = true;
      for (var i = rs + 29; i < rs + 29 + labelLength; i++) {
        if (d[i] < 32 || d[i] >= 127) { printable = false; break; }
      }
      if (printable) labelText = stripNulSpace(this.asciiIgnore(rs + 29, rs + 29 + labelLength));
    }
    if (labelText) {
      var sep = 29 + labelLength;
      var c1x = safeRound(f64(sep + 8));
      var c1y = safeRound(f64(sep + 16));
      var c2x = safeRound(f64(sep + 50));
      var c2y = safeRound(f64(sep + 58));
      var c3x = safeRound(f64(sep + 66));
      var c3y = safeRound(f64(sep + 74));
      cols.row_variant = 'label';
      cols.label = labelText;
      cols.label_length = labelLength;
      cols.prefix_float = safeRound(f32(17));
      cols.code_u16 = u16(25);
      cols.separator_1 = byteOr0(sep);
      cols.style_code = u32(sep + 1);
      cols.flag_1 = byteOr0(sep + 5);
      cols.flag_2 = byteOr0(sep + 6);
      cols.flag_3 = byteOr0(sep + 7);
      cols.coord_1_x = c1x;
      cols.coord_1_y = c1y;
      cols.separator_2 = byteOr0(sep + 35);
      cols.scale_float = safeRound(f32(sep + 46));
      cols.coord_2_x = c2x;
      cols.coord_2_y = c2y;
      cols.coord_3_x = c3x;
      cols.coord_3_y = c3y;
      return row;
    }
    if (L >= 119) {
      var k0x = safeRound(f64(17));
      var k0y = safeRound(f64(25));
      var k1x = safeRound(f64(45));
      var k1y = safeRound(f64(53));
      var k2x = safeRound(f64(87));
      var k2y = safeRound(f64(95));
      var k3x = safeRound(f64(103));
      var k3y = safeRound(f64(111));
      var plausible = looksLikeXY(k0x, k0y) && looksLikeXY(k1x, k1y) && looksLikeXY(k2x, k2y);
      if (!plausible) {
        cols.ascii_values = this.asciiValuesJoined(rs, re, tableRef);
        return row;
      }
      cols.row_variant = 'segment';
      cols.coord_0_x = k0x;
      cols.coord_0_y = k0y;
      cols.style_code = u32(37);
      cols.flag_1 = byteOr0(41);
      cols.flag_2 = byteOr0(42);
      cols.flag_3 = byteOr0(43);
      cols.flag_4 = byteOr0(44);
      cols.coord_1_x = k1x;
      cols.coord_1_y = k1y;
      cols.separator_2 = byteOr0(72);
      cols.coord_2_x = k2x;
      cols.coord_2_y = k2y;
      cols.coord_3_x = k3x;
      cols.coord_3_y = k3y;
      return row;
    }
    cols.ascii_values = this.asciiValuesJoined(rs, re, tableRef);
    return row;
  };

  P.asciiValuesJoined = function (rs, re, tableRef) {
    var values = this.collectAsciiFields(rs, re);
    var out = [];
    for (var i = 0; i < values.length; i++) {
      if (values[i] !== tableRef) out.push(values[i]);
    }
    return out.join(' | ');
  };

  P.collectAsciiFields = function (rs, re) {
    var d = this.data;
    var L = re - rs;
    var values = [];
    var seen = {};
    var limit = Math.max(0, L - 1);
    for (var index = 0; index < limit; index++) {
      var len = d[rs + index];
      if (len <= 0 || len > 64 || index + 1 + len > L) continue;
      var start = rs + index + 1, end = start + len, ok = true, j;
      for (j = start; j < end; j++) {
        if (d[j] < 32 || d[j] >= 127) { ok = false; break; }
      }
      if (!ok) continue;
      var value = stripNulSpace(this.asciiIgnore(start, end));
      if (!value) continue;
      if (!allPrintableOrTab(value)) continue;
      if (hasOwn.call(seen, '$' + value)) continue;
      seen['$' + value] = true;
      values.push(value);
    }
    return values;
  };

  function safeRound(v) {
    if (!isFinite(v)) return null;
    if (Math.abs(v) < 1e-12) return 0.0;
    return pyRound6(v);
  }

  function looksLikeXY(x, y) {
    return x !== null && y !== null && isFinite(x) && isFinite(y) &&
      Math.abs(x) <= 100000000 && Math.abs(y) <= 100000000 &&
      (Math.abs(x) >= 1000 || Math.abs(y) >= 1000);
  }

  // ---- Strings and small readers ------------------------------------

  P.readTextPayload = function (offset, ext) {
    var text = this.readLengthPrefixedText(offset + ext + 97, offset + ext + 98);
    if (text) return text;
    text = this.readLengthPrefixedText(offset + ext + 86, offset + ext + 87);
    if (text) return text;
    text = this.readLengthPrefixedText(offset + 97, offset + 98);
    if (text) return text;
    return this.readLengthPrefixedText(offset + 86, offset + 87);
  };

  P.readLengthPrefixedText = function (lengthOffset, textOffset) {
    var n = this.n;
    if (lengthOffset < 0 || lengthOffset >= n || textOffset < 0 || textOffset >= n) return '';
    var len = this.data[lengthOffset];
    if (len <= 0 || len > 240 || textOffset + len > n) return '';
    return stripNulSpace(this.readLegacyString(textOffset, len));
  };

  P.readPositiveFloat = function (offset) {
    if (offset < 0 || offset + 4 > this.n) return null;
    var v = this.f32(offset);
    if (!isFinite(v) || v <= 0.0 || v > 100000.0) return null;
    return v;
  };

  P.readPlanBoxName = function (offset, blockSize) {
    var d = this.data;
    var end = Math.min(this.n, offset + blockSize + 1);
    var stop = Math.max(offset, end - 4);
    for (var index = offset; index < stop; index++) {
      if (index + 4 > end) break;
      // bytes.lower() == b'plan' (ASCII case folding only)
      if ((d[index] | 32) !== 112 || (d[index + 1] | 32) !== 108 ||
          (d[index + 2] | 32) !== 97 || (d[index + 3] | 32) !== 110) continue;
      if (!isAsciiLetter(d[index]) || !isAsciiLetter(d[index + 1]) ||
          !isAsciiLetter(d[index + 2]) || !isAsciiLetter(d[index + 3])) continue;
      var cursor = index + 4;
      while (cursor < end && cursor - index < 32 && isTokenByte(d[cursor])) cursor += 1;
      if (cursor <= index + 4) continue;
      var name = stripNulSpace(this.asciiIgnore(index, cursor));
      if (name.length > 4 && isAsciiDigits(name.substring(4))) return name;
    }
    return '';
  };

  function isAsciiLetter(v) {
    return (v >= 65 && v <= 90) || (v >= 97 && v <= 122);
  }

  P.readLengthPrefixedName = function (start, end) {
    var d = this.data;
    var boundedEnd = Math.min(end, this.n);
    var stop = Math.max(0, boundedEnd - 2);
    for (var index = Math.max(0, start); index < stop; index++) {
      var len = d[index];
      if (len <= 0 || len > 64 || index + 1 + len > boundedEnd) continue;
      var value = stripNulSpace(this.readLegacyString(index + 1, len));
      if (value && allPrintableOrTab(value)) return value;
    }
    return '';
  };

  P.readAsciiToken = function (start, end) {
    var d = this.data;
    var boundedEnd = Math.min(end, this.n);
    var cursor = Math.max(0, start);
    while (cursor < boundedEnd) {
      if (!isTokenByte(d[cursor])) {
        cursor += 1;
        continue;
      }
      var tokenStart = cursor;
      while (cursor < boundedEnd && isTokenByte(d[cursor])) cursor += 1;
      if (cursor - tokenStart >= 3) return this.asciiIgnore(tokenStart, cursor);
    }
    return '';
  };

  P.readEpsg = function (offset, maxLength) {
    var d = this.data, n = this.n;
    for (var index = 0; index < maxLength - 3; index++) {
      var p = offset + index;
      if (p + 2 >= n) break;
      if (d[p] === 83 && d[p + 1] === 82 && d[p + 2] === 83) { // 'SRS'
        var s = '';
        var cursor = 0;
        while (p + cursor < n && d[p + cursor] !== 62) {
          s += LEGACY_CHARS[d[p + cursor]];
          cursor += 1;
        }
        return s.split('SRS:').join('').split('"').join('');
      }
    }
    return '';
  };

  P.readLegacyString = function (offset, length) {
    var d = this.data;
    var end = offset + length;
    if (end > this.n) end = this.n;
    var s = '';
    for (var i = offset; i < end; i++) s += LEGACY_CHARS[d[i]];
    return rstripNul(s);
  };

  // bytes.decode('ascii', errors='ignore')
  P.asciiIgnore = function (start, end) {
    var d = this.data;
    if (end > this.n) end = this.n;
    var s = '';
    for (var i = start; i < end; i++) {
      if (d[i] < 128) s += LEGACY_CHARS[d[i]];
    }
    return s;
  };

  P.findAscii = function (needle, from) {
    var d = this.data, n = this.n, m = needle.length;
    var first = needle.charCodeAt(0);
    var pos = from;
    while (pos <= n - m) {
      pos = d.indexOf(first, pos);
      if (pos < 0 || pos > n - m) return -1;
      var k = 1;
      while (k < m && d[pos + k] === needle.charCodeAt(k)) k++;
      if (k === m) return pos;
      pos += 1;
    }
    return -1;
  };

  P.containsAscii = function (start, end, needle) {
    var d = this.data, m = needle.length;
    for (var i = start; i + m <= end; i++) {
      var k = 0;
      while (k < m && d[i + k] === needle.charCodeAt(k)) k++;
      if (k === m) return true;
    }
    return false;
  };

  // int.from_bytes(data[offset:offset+4], 'little') (slice is lenient)
  P.readUint32 = function (offset) {
    var d = this.data;
    if (offset >= 0 && offset + 4 <= this.n) {
      return d[offset] + d[offset + 1] * 256 + d[offset + 2] * 65536 + d[offset + 3] * 16777216;
    }
    var v = 0, mul = 1;
    for (var i = offset; i < offset + 4 && i < this.n; i++) {
      v += d[i] * mul;
      mul *= 256;
    }
    return v;
  };

  // struct.unpack_from('<d' / '<f'); DataView throws RangeError like struct.error.
  P.f64 = function (offset) { return this.view.getFloat64(offset, true); };
  P.f32 = function (offset) { return this.view.getFloat32(offset, true); };

  P.geometryColor = function (layerCode, colorCode) {
    if (colorCode === 1) return toArgb(0, 0, 255);
    if (colorCode === 255) return toArgb(255, 0, 0);
    if (colorCode !== 0) return null;
    var colors = this.layer_colors;
    if (layerCode >= 0 && layerCode < colors.length) return normalizeLayerColor(colors[layerCode]);
    if (layerCode - 1 >= 0 && layerCode - 1 < colors.length) return normalizeLayerColor(colors[layerCode - 1]);
    return null;
  };

  P.layerName = function (layerCode) {
    var names = this.layer_names;
    if (layerCode >= 0 && layerCode < names.length) return names[layerCode];
    if (layerCode - 1 >= 0 && layerCode - 1 < names.length) return names[layerCode - 1];
    return '';
  };

  // ---- Geometry helpers ---------------------------------------------

  // Unsigned 32-bit ARGB as a plain number (Python int semantics).
  function toArgb(r, g, b) {
    return 4278190080 + r * 65536 + g * 256 + b;
  }

  function normalizeLayerColor(argb) {
    var red = Math.floor(argb / 65536) % 256;
    var green = Math.floor(argb / 256) % 256;
    var blue = argb % 256;
    if (red === 0 && green === 0 && blue <= 1) return toArgb(0, 0, 0);
    return argb;
  }

  function coordinate(rawX, rawY, z) {
    return { x: rawY, y: rawX, z: z };
  }

  function validXY(x, y) {
    return isFinite(x) && isFinite(y) && Math.abs(x) <= 100000000 && Math.abs(y) <= 100000000;
  }

  // Python min()/max() of two values: returns the first on ties.
  function pyMin(a, b) { return b < a ? b : a; }
  function pyMax(a, b) { return b > a ? b : a; }

  function sameCoordinate(a, b) {
    return Math.abs(a.x - b.x) < 0.001 && Math.abs(a.y - b.y) < 0.001 && Math.abs(a.z - b.z) < 0.001;
  }

  function distance(a, b) {
    var dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  function isNearlyClosed(coords) {
    if (coords.length < 4) return false;
    var first = coords[0];
    var last = coords[coords.length - 1];
    if (sameCoordinate(first, last)) return true;
    if (coords.length < 5) return false;
    var second = coords[1];
    var penultimate = coords[coords.length - 2];
    var firstEdge = distance(first, second);
    var lastEdge = distance(penultimate, last);
    var closureGap = distance(first, last);
    var referenceLength = pyMin(firstEdge, lastEdge);
    if (referenceLength <= 0.001) return false;
    var tolerance = pyMax(referenceLength * 0.2, 0.05);
    return closureGap <= tolerance;
  }

  function nearlyOrthogonal(a, b, aLen, bLen) {
    return Math.abs((a[0] * b[0] + a[1] * b[1]) / (aLen * bLen)) <= 0.03;
  }

  function nearlyEqual(a, b) {
    var tolerance = pyMax(pyMax(Math.abs(a), Math.abs(b)) * 0.02, 0.02);
    return Math.abs(a - b) <= tolerance;
  }

  function simplifyCollinearRing(points) {
    if (points.length <= 4) return points;
    var s = points.slice();
    var removed = true;
    while (removed && s.length > 4) {
      removed = false;
      var len = s.length;
      for (var index = 0; index < len; index++) {
        var prev = s[(index - 1 + len) % len];
        var current = s[index];
        var next = s[(index + 1) % len];
        var ax = current.x - prev.x;
        var ay = current.y - prev.y;
        var bx = next.x - current.x;
        var by = next.y - current.y;
        var aLen = Math.sqrt(ax * ax + ay * ay);
        var bLen = Math.sqrt(bx * bx + by * by);
        if (aLen < 0.001 || bLen < 0.001) {
          s.splice(index, 1);
          removed = true;
          break;
        }
        var cross = Math.abs(ax * by - ay * bx) / (aLen * bLen);
        if (cross <= 0.02) {
          s.splice(index, 1);
          removed = true;
          break;
        }
      }
    }
    return s;
  }

  function boxMetrics(coords) {
    var no = { isBox: false, width: 0.0, height: 0.0, rotation: 0.0, coordinates: coords };
    if (coords.length < 5) return no;
    var unique = coords;
    if (sameCoordinate(coords[0], coords[coords.length - 1])) unique = coords.slice(0, -1);
    unique = simplifyCollinearRing(unique);
    if (unique.length !== 4) return no;
    function vec(a, b) { return [b.x - a.x, b.y - a.y]; }
    function len(v) { return Math.sqrt(v[0] * v[0] + v[1] * v[1]); }
    var edges = [
      vec(unique[0], unique[1]),
      vec(unique[1], unique[2]),
      vec(unique[2], unique[3]),
      vec(unique[3], unique[0])
    ];
    var lengths = [len(edges[0]), len(edges[1]), len(edges[2]), len(edges[3])];
    for (var i = 0; i < 4; i++) if (lengths[i] < 0.001) return no;
    var oppositeEqual = nearlyEqual(lengths[0], lengths[2]) && nearlyEqual(lengths[1], lengths[3]);
    // Python all((...)) over a tuple evaluates every term first.
    var o0 = nearlyOrthogonal(edges[0], edges[1], lengths[0], lengths[1]);
    var o1 = nearlyOrthogonal(edges[1], edges[2], lengths[1], lengths[2]);
    var o2 = nearlyOrthogonal(edges[2], edges[3], lengths[2], lengths[3]);
    var o3 = nearlyOrthogonal(edges[3], edges[0], lengths[3], lengths[0]);
    var rightAngles = o0 && o1 && o2 && o3;
    if (!oppositeEqual || !rightAngles) return no;
    var rotation = pyMod(Math.atan2(edges[0][1], edges[0][0]) * RAD_TO_DEG, 360.0);
    return { isBox: true, width: lengths[0], height: lengths[1], rotation: rotation, coordinates: coords };
  }

  // ---- Entry point --------------------------------------------------

  function toUint8Array(input) {
    if (input instanceof Uint8Array) return input;
    if (typeof ArrayBuffer !== 'undefined') {
      if (input instanceof ArrayBuffer) return new Uint8Array(input);
      if (ArrayBuffer.isView && ArrayBuffer.isView(input)) {
        return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      }
    }
    if (input && typeof input.byteLength === 'number') return new Uint8Array(input);
    throw new TypeError('parseNCZ expects an ArrayBuffer or Uint8Array');
  }

  return function parseNCZ(input) {
    return new NCZParser(toUint8Array(input)).parse();
  };
})();

if (typeof window !== 'undefined') window.parseNCZ = parseNCZ;
if (typeof module !== 'undefined') module.exports = parseNCZ;
