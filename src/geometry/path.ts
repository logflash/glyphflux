import type { PathCommand } from 'opentype.js'
import type { FontMorphPoint } from '../contracts/font'
import { quantizeCoordinate } from '../compiler/fixedPoint'

interface MutablePoint {
  x: number
  y: number
}

function point(x: number, y: number): MutablePoint {
  return { x: quantizeCoordinate(x), y: quantizeCoordinate(-y) }
}

function distanceToLineSquared(value: MutablePoint, start: MutablePoint, end: MutablePoint) {
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (dx === 0 && dy === 0) {
    return (value.x - start.x) ** 2 + (value.y - start.y) ** 2
  }
  const cross = dy * value.x - dx * value.y + end.x * start.y - end.y * start.x
  return (cross * cross) / (dx * dx + dy * dy)
}

function midpoint(left: MutablePoint, right: MutablePoint): MutablePoint {
  return { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 }
}

function flattenQuadratic(
  start: MutablePoint,
  control: MutablePoint,
  end: MutablePoint,
  toleranceSquared: number,
  output: MutablePoint[],
  depth = 0,
) {
  if (depth >= 18 || distanceToLineSquared(control, start, end) <= toleranceSquared) {
    output.push(end)
    return
  }
  const leftControl = midpoint(start, control)
  const rightControl = midpoint(control, end)
  const split = midpoint(leftControl, rightControl)
  flattenQuadratic(start, leftControl, split, toleranceSquared, output, depth + 1)
  flattenQuadratic(split, rightControl, end, toleranceSquared, output, depth + 1)
}

function flattenCubic(
  start: MutablePoint,
  control1: MutablePoint,
  control2: MutablePoint,
  end: MutablePoint,
  toleranceSquared: number,
  output: MutablePoint[],
  depth = 0,
) {
  const flatness = Math.max(
    distanceToLineSquared(control1, start, end),
    distanceToLineSquared(control2, start, end),
  )
  if (depth >= 18 || flatness <= toleranceSquared) {
    output.push(end)
    return
  }
  const left1 = midpoint(start, control1)
  const center = midpoint(control1, control2)
  const right2 = midpoint(control2, end)
  const left2 = midpoint(left1, center)
  const right1 = midpoint(center, right2)
  const split = midpoint(left2, right1)
  flattenCubic(start, left1, left2, split, toleranceSquared, output, depth + 1)
  flattenCubic(split, right1, right2, end, toleranceSquared, output, depth + 1)
}

function samePoint(left: MutablePoint, right: MutablePoint) {
  return left.x === right.x && left.y === right.y
}

function closeContour(points: MutablePoint[]) {
  const deduplicated: FontMorphPoint[] = []
  for (const value of points) {
    const next = [quantizeCoordinate(value.x), quantizeCoordinate(value.y)] as const
    const previous = deduplicated.at(-1)
    if (!previous || previous[0] !== next[0] || previous[1] !== next[1]) deduplicated.push(next)
  }
  if (
    deduplicated.length > 1 &&
    deduplicated[0][0] === deduplicated.at(-1)![0] &&
    deduplicated[0][1] === deduplicated.at(-1)![1]
  ) {
    deduplicated.pop()
  }
  return deduplicated
}

export function flattenPath(commands: readonly PathCommand[], tolerance = 1 / 2048) {
  const contours: FontMorphPoint[][] = []
  let output: MutablePoint[] = []
  let current: MutablePoint | null = null
  let start: MutablePoint | null = null
  const toleranceSquared = tolerance * tolerance

  const finish = () => {
    const contour = closeContour(output)
    if (contour.length >= 3) contours.push(contour)
    output = []
    current = null
    start = null
  }

  for (const command of commands) {
    if (command.type === 'M') {
      if (output.length) finish()
      current = point(command.x, command.y)
      start = current
      output.push(current)
    } else if (command.type === 'Z') {
      if (current && start && !samePoint(current, start)) output.push(start)
      finish()
    } else {
      if (!current) throw new Error(`Glyphflux outline command ${command.type} has no move point`)
      const end = point(command.x, command.y)
      if (command.type === 'L') {
        output.push(end)
      } else if (command.type === 'Q') {
        flattenQuadratic(current, point(command.x1, command.y1), end, toleranceSquared, output)
      } else if (command.type === 'C') {
        flattenCubic(
          current,
          point(command.x1, command.y1),
          point(command.x2, command.y2),
          end,
          toleranceSquared,
          output,
        )
      }
      current = end
    }
  }
  if (output.length) finish()
  return contours
}
