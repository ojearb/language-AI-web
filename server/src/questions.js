import { createHash } from 'node:crypto';

const clean = (text) => text.replace(/^\s*#{1,6}\s+/gm, '').replace(/\*\*|__/g, '').trim();
const time = /^(?:(?:AM|PM)\s*)?\d{1,2}:\d{2}(?:\s*(?:AM|PM))?\.?$/i;
const introduction = /^(?:here (?:are|is)|(?:translate|answer|practice|try) (?:the |these |each |following )|(?:sentences|questions|examples|exercises)\s*:)\b/i;

// Exercises are not necessarily questions: translation sentences and times have no '?'.
export function extractQuestions(content, { prompt = '' } = {}) {
  let source = content.trim().replace(/^```[^\n]*\n|\n```$/g, '');
  if (!source) return [];
  if (!source.includes('\n') && /^\s*1[.)]\s/.test(source)) source = source.replace(/\s+(?=\d+[.)]\s)/g, '\n');
  const lines = source.split(/\r?\n/);
  const marker = /^\s*(?:(?:[-*•]\s+)?(?:Question|Q|Sentence|Example|Exercise|Fråga|Uppgift)\s*\d+[.)\]:-]?|\(?\d+[.)\]:])(?:\s+(.*))?$/i;
  const numbered = boundaries(lines, (line) => clean(line).match(marker));
  if (numbered.length) return collect(lines, numbered);

  const bullets = boundaries(lines, (line) => line.match(/^\s*[-*•–]\s+(.+)$/));
  if (bullets.length > 1) return collect(lines, bullets);

  const paragraphs = source.split(/\n\s*\n/).map(clean).filter(Boolean);
  const meaningful = paragraphs.filter((part) => !introduction.test(part));
  if (meaningful.length > 1) return meaningful;

  const plainLines = (meaningful[0] ?? source).split(/\r?\n/).map(clean).filter((line) => line && !introduction.test(line));
  if (plainLines.length > 1) {
    // A location followed by two clock values is one interval exercise, not three.
    const intervals = [];
    let position = 0;
    while (position < plainLines.length) {
      if (!time.test(plainLines[position]) && time.test(plainLines[position + 1] ?? '') && time.test(plainLines[position + 2] ?? '')) {
        intervals.push(plainLines.slice(position, position + 3).join('\n'));
        position += 3;
      } else if (/time\s*(?:pairs|intervals)|pairs?\s+of\s+times/i.test(prompt) && time.test(plainLines[position]) && time.test(plainLines[position + 1] ?? '')) {
        intervals.push(plainLines.slice(position, position + 2).join('\n'));
        position += 2;
      } else break;
    }
    if (position === plainLines.length) return intervals;
    // Preserve a single multi-line task with explanation; split lists of standalone items.
    if (plainLines.every((line) => time.test(line) || /[.!?。？！][”"']?$/.test(line))
      || /(?:list|series|\d+|five|twenty)\b.*\b(?:sentences|times|examples)/is.test(prompt)) return plainLines;
  }

  // Some models put all translation sentences on one line despite asking for a list.
  if (/(?:sentences|translation practice)/i.test(prompt) && !/\n/.test(source)) {
    const sentences = [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(source)].map(({ segment }) => segment.trim()).filter(Boolean);
    if (sentences.length > 1) return sentences;
  }
  return [meaningful[0] ?? clean(source)];
}

function boundaries(lines, match) {
  const candidates = lines.map((line, index) => ({ match: match(line), index, indent: line.match(/^\s*/)[0].length })).filter((item) => item.match);
  const topIndent = Math.min(...candidates.map((item) => item.indent));
  return candidates.filter((item) => item.indent === topIndent);
}

function collect(lines, items) {
  return items.map((item, index) => clean([item.match[1] ?? '', ...lines.slice(item.index + 1, items[index + 1]?.index ?? lines.length)].join('\n'))).filter(Boolean);
}

export function withQuestions(conversation) {
  if (!conversation) return null;
  const prompt = conversation.messages.find((message) => message.role === 'user')?.content ?? '';
  const reviews = conversation.messages.filter((message) => message.kind === 'answer-review' && message.role === 'user');
  return {
    ...conversation,
    questions: conversation.messages
      .filter((message) => message.role === 'assistant' && message.kind !== 'answer-review')
      .flatMap((message) => extractQuestions(message.content, { prompt }).map((text, index) => {
        // Keep exact old reviews linked. A former combined answer must not become a
        // review of the first newly separated exercise just because both use index 0.
        const previous = reviews.find((review) => review.question === text && review.questionId?.startsWith(`${message.id}:`));
        const fingerprint = createHash('sha256').update(text).digest('hex').slice(0, 12);
        return { id: previous?.questionId ?? `${message.id}:${index}-${fingerprint}`, messageId: message.id, text };
      })),
  };
}
