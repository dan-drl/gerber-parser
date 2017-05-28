// parse drill function
// takes a parser transform stream and a block string
'use strict'

var numIsFinite = require('lodash.isfinite')

var commands = require('./_commands')
var drillMode = require('./_drill-mode')
var normalize = require('./normalize-coord')
var parseCoord = require('./parse-coord')

var reALTIUM_HINT = /;FILE_FORMAT=(\d):(\d)/
var reKI_HINT = /;FORMAT={(.):(.)\/ (absolute|.+)? \/ (metric|inch) \/.+(trailing|leading|decimal|keep)/

var reUNITS = /(INCH|METRIC)(?:,([TL])Z)?/
var reTOOL_DEF = /T0*(\d+)[\S]*C([\d.]+)/
var reTOOL_SET = /T0*(\d+)(?![\S]*C)/
var reCOORD = /((?:[XYIJA][+-]?[\d.]+){1,4})(?:G85((?:[XY][+-]?[\d.]+){1,2}))?/
var reROUTE = /^G0([01235])/

var setUnits = function(parser, units) {
  var format = (units === 'in') ? [2, 4] : [3, 3]
  if (!parser.format.places) {
    parser.format.places = format
  }
  return parser._push(commands.set('units', units))
}

var parseCommentForFormatHints = function(parser, block) {
  var result = {}

  if (reKI_HINT.test(block)) {
    var kicadMatch = block.match(reKI_HINT)
    var leading = Number(kicadMatch[1])
    var trailing = Number(kicadMatch[2])
    var absolute = kicadMatch[3]
    var unitSet = kicadMatch[4]
    var suppressionSet = kicadMatch[5]

    // set format if we got numbers
    if (numIsFinite(leading) && numIsFinite(trailing)) {
      result.places = [leading, trailing]
    }

    // send backup notation
    if (absolute === 'absolute') {
      parser._push(commands.set('backupNota', 'A'))
    }
    else {
      parser._push(commands.set('backupNota', 'I'))
    }

    // send units
    if (unitSet === 'metric') {
      parser._push(commands.set('backupUnits', 'mm'))
    }
    else {
      parser._push(commands.set('backupUnits', 'in'))
    }

    // set zero suppression
    if (suppressionSet === 'leading' || suppressionSet === 'keep') {
      result.zero = 'L'
    }
    else if (suppressionSet === 'trailing') {
      result.zero = 'T'
    }
    else {
      result.zero = 'D'
    }
  }

  // check for altium format hints if the format is not already set
  else if (reALTIUM_HINT.test(block)) {
    var altiumMatch = block.match(reALTIUM_HINT)

    result.places = [Number(altiumMatch[1]), Number(altiumMatch[2])]
  }

  return result
}

var coordToCommand = function(parser, block) {
  var coordMatch = block.match(reCOORD)
  var coord = parseCoord(coordMatch[1], parser.format)

  // if there's another match, then it was a slot
  if (coordMatch[2]) {
    parser._push(commands.op('move', coord))
    parser._push(commands.set('mode', 'i'))
    coord = parseCoord(coordMatch[2], parser.format)

    return parser._push(commands.op('int', coord))
  }

  // get the drill mode if a route command is present
  if (reROUTE.test(block)) {
    parser._drillMode = block.match(reROUTE)[1]
  }

  switch (parser._drillMode) {
    case drillMode.DRILL:
      return parser._push(commands.op('flash', coord))

    case drillMode.MOVE:
      return parser._push(commands.op('move', coord))

    case drillMode.LINEAR:
      parser._push(commands.set('mode', 'i'))
      return parser._push(commands.op('int', coord))

    case drillMode.CW_ARC:
      parser._push(commands.set('mode', 'cw'))
      return parser._push(commands.op('int', coord))

    case drillMode.CCW_ARC:
      parser._push(commands.set('mode', 'ccw'))
      return parser._push(commands.op('int', coord))
  }
}

var parse = function(parser, block) {
  parser._drillStash = parser._drillStash || []
  // parse comments for formatting hints and ignore the rest
  if (block[0] === ';') {
    // check for kicad format hints
    var formatHints = parseCommentForFormatHints(parser, block)

    Object.keys(formatHints).forEach(function(key) {
      if (!parser.format[key]) {
        parser.format[key] = formatHints[key]
      }
    })

    return
  }

  if (reTOOL_DEF.test(block)) {
    var toolMatch = block.match(reTOOL_DEF)
    var toolCode = toolMatch[1]
    var toolDia = normalize(toolMatch[2])
    var toolDef = {shape: 'circle', params: [toolDia], hole: []}

    return parser._push(commands.tool(toolCode, toolDef))
  }

  // tool set
  if (reTOOL_SET.test(block)) {
    var toolSet = block.match(reTOOL_SET)[1]

    // allow tool set to fall through because it can happen on the
    // same line as a coordinate operation
    parser._push(commands.set('tool', toolSet))
  }

  if (reCOORD.test(block)) {
    // detect or assume format
    if (!parser.format.zero) {
      if (parser._drillStash.length >= 1000) {
        parser.format.zero = 'T'
        parser._warn('zero suppression missing and not detectable;'
          + ' assuming trailing suppression')
      }
      else {
        parser.format.zero = parseCoord.detectZero(block)
        if (parser.format.zero) {
          var zero = parser.format.zero === 'L' ? 'leading' : 'trailing'
          parser._warn('zero suppression missing; detected '
            + zero + ' suppression')
        }
        return parser._drillStash.push(block)
      }
    }

    if (!parser.format.places) {
      parser.format.places = [2, 4]
      parser._warn('places format missing; assuming [2, 4]')
    }

    if (parser._drillStash.length) {
      parser._drillStash.forEach(function(block) {
        coordToCommand(parser, block)
      })
      parser._drillStash = []
    }

    return coordToCommand(parser, block)
  }

  if ((block === 'M00') || (block === 'M30')) {
    return parser._push(commands.done())
  }

  if (block === 'M71') {
    return setUnits(parser, 'mm')
  }

  if (block === 'M72') {
    return setUnits(parser, 'in')
  }

  if (block === 'G90') {
    return parser._push(commands.set('nota', 'A'))
  }

  if (block === 'G91') {
    return parser._push(commands.set('nota', 'I'))
  }

  if (reUNITS.test(block)) {
    var unitsMatch = block.match(reUNITS)
    var units = unitsMatch[1]
    var suppression = unitsMatch[2]

    if (units === 'METRIC') {
      setUnits(parser, 'mm')
    }
    else {
      setUnits(parser, 'in')
    }

    if (suppression === 'T') {
      parser.format.zero = parser.format.zero || 'L'
    }
    else if (suppression === 'L') {
      parser.format.zero = parser.format.zero || 'T'
    }

    return
  }

  return
}

parse.flush = function(parser) {
  if (!parser.format.zero) {
    parser.format.zero = 'T'
    parser._warn('zero suppression missing and not detectable;'
      + ' assuming trailing suppression')
  }
  if (parser._drillStash.length) {
    parser._drillStash.forEach(function(block) {
      coordToCommand(parser, block)
    })
    parser._drillStash = []
  }
}

module.exports = parse
