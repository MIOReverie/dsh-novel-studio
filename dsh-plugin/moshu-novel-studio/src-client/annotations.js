'use strict';

/** src/lib/annotations.ts 的直译（去掉 TS 类型）。 */

function findAll(content, quote) {
  const positions = [];
  let from = 0;

  while (from <= content.length - quote.length) {
    const found = content.indexOf(quote, from);
    if (found === -1) break;
    positions.push(found);
    // 前进一位，允许故意重叠的引用。
    from = found + 1;
  }

  return positions;
}

/**
 * 文档改动后重新定位一条批注，不改动任何入参。
 *
 * 已保存的位置是最强的证据；否则必须由引用原文加上下文唯一确定。
 * 缺上下文时绝不用重复文本来猜，也不做模糊匹配——错锚比过期更糟。
 */
function relocateAnnotation(content, annotation) {
  const start = annotation.start;
  const end = annotation.end;
  const quote = annotation.quote;
  const prefix = annotation.prefix;
  const suffix = annotation.suffix;
  const stale = function () {
    return Object.assign({}, annotation, { status: 'stale' });
  };

  if (!quote) return stale();

  if (
    start !== undefined &&
    end !== undefined &&
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end === start + quote.length &&
    content.slice(start, end) === quote
  ) {
    return Object.assign({}, annotation, { status: 'open' });
  }

  const occurrences = findAll(content, quote);
  const contextual = occurrences.filter(function (candidate) {
    const candidateEnd = candidate + quote.length;
    return (
      (prefix === undefined || content.slice(0, candidate).endsWith(prefix)) &&
      (suffix === undefined || content.slice(candidateEnd).startsWith(suffix))
    );
  });

  // 唯一的引用即使上下文变了也可靠；出现多次时必须靠上下文定位。
  const candidates = contextual.length > 0 ? contextual : occurrences.length === 1 ? occurrences : [];

  if (candidates.length !== 1) return stale();

  const newStart = candidates[0];
  return Object.assign({}, annotation, { start: newStart, end: newStart + quote.length, status: 'open' });
}

module.exports = { relocateAnnotation: relocateAnnotation };
