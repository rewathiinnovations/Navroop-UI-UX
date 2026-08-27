import { describe, expect, it } from 'vitest';
import {
  needImageKey,
  parseNeedImageDirectives,
  placeholderReplacements,
  replaceNeedImageTokens,
  stripNeedImageTokens,
  sweepNeedImageTokens,
} from '@/lib/assets/need-image';

/**
 * A generated site must never ship the literal request token as an image URL.
 *
 * The stack prompt tells the model to ask for pictures as
 * `NEED_IMAGE: description | 16:9` and promises the pipeline swaps them for
 * real URLs before files are written. That step stopped being called when the
 * apply route was deleted, so a real generation stored
 * `<img src="NEED_IMAGE: Warm coffee roastery hero background…">` and the hero
 * image was broken in the preview and would have been broken in production.
 */

// Verbatim from the first live generation (Harbor & Pine, REACT).
const HERO = `      <div className="absolute inset-0">
        <img
          src="NEED_IMAGE: Warm coffee roastery hero background with coffee beans and roaster | 16:9"
          alt="Coffee beans roasting in a warm Portland roastery"
          className="w-full h-full object-cover"
        />
      </div>`;

describe('NEED_IMAGE tokens never reach the stored site', () => {
  it('finds the directive in real generated output', () => {
    const directives = parseNeedImageDirectives(HERO);
    expect(directives).toHaveLength(1);
    expect(directives[0].description).toContain('coffee roastery hero background');
    expect(directives[0].aspect).toBe('16:9');
  });

  it('replaces an unfulfilled token with a self-contained placeholder', () => {
    const resolved = replaceNeedImageTokens(HERO, placeholderReplacements(HERO));
    expect(resolved).not.toContain('NEED_IMAGE');
    expect(resolved).toContain('src="data:image/svg+xml');
    // Inline, so a deployed site needs no network fetch to render it.
    expect(resolved).not.toContain('http://');
    // The alt text the model wrote survives.
    expect(resolved).toContain('Coffee beans roasting in a warm Portland roastery');
  });

  it('leaves a fulfilled token alone', () => {
    const real = replaceNeedImageTokens(HERO, [
      {
        token:
          'NEED_IMAGE: Warm coffee roastery hero background with coffee beans and roaster | 16:9',
        url: 'https://assets.example.com/hero.jpg',
      },
    ]);
    expect(real).toContain('https://assets.example.com/hero.jpg');
    expect(placeholderReplacements(real)).toEqual([]);
  });
});

/**
 * Verbatim from a later live generation (Cinder & Sage, NEXTJS), which shipped two
 * raw tokens into the user's `lib/site.ts`. The aspects are `3:4` and `4:3` — not
 * on the advertised list — and because the description cannot contain `|`, the
 * pattern failed to match them at all: fulfilment never saw them, the placeholder
 * pass never saw them, and the literal string reached stored code.
 */
const SHIPPED_RAW = `  {
    src: "NEED_IMAGE: Blazing wood-fired brick oven with a pizza inside and a chef working the peel | 3:4",
    alt: "The wood-fired oven blazing with a pizza inside",
  },
  {
    src: "NEED_IMAGE: Cozy pizzeria bar with warm pendant lights, shelves of natural wine and a counter | 4:3",
    alt: "The bar counter with natural wine bottles under warm pendant lights",
  },`;

describe('an aspect nobody advertised is still a request', () => {
  it('parses directives whose ratio is not on the list', () => {
    const directives = parseNeedImageDirectives(SHIPPED_RAW);

    expect(directives).toHaveLength(2);
    expect(directives[0].description).toContain('wood-fired brick oven');
    // The description must not swallow the ratio, or the search query is polluted.
    expect(directives[0].description).not.toContain('3:4');
    expect(directives[1].description).toContain('Cozy pizzeria bar');
  });

  it('serves the nearest shape it can produce, matching the requested orientation', () => {
    const [portrait, landscape] = parseNeedImageDirectives(SHIPPED_RAW);

    expect(portrait.aspect).toBe('4:5');
    expect(landscape.aspect).toBe('16:9');
  });

  it('replaces them, so nothing raw is stored', () => {
    const resolved = replaceNeedImageTokens(SHIPPED_RAW, placeholderReplacements(SHIPPED_RAW));

    expect(resolved).not.toContain('NEED_IMAGE');
    expect(resolved).toContain('data:image/svg+xml');
    expect(resolved).toContain('The bar counter with natural wine bottles');
  });

  it('sweeps a shape even the parser misses', () => {
    // No closing quote, a stray pipe, a newline mid-token: whatever the model does,
    // a `NEED_IMAGE:` string must not survive into generated source.
    const malformed = 'const src = "NEED_IMAGE: a pizza | | weird";\nconst other = 1;';
    const swept = sweepNeedImageTokens(malformed);

    expect(swept).not.toContain('NEED_IMAGE');
    expect(swept).toContain('data:image/svg+xml');
    // Everything around it is untouched.
    expect(swept).toContain('const other = 1;');
  });

  it('leaves text with no token exactly as it is', () => {
    const clean = 'const src = "/assets/hero.jpg";';
    expect(sweepNeedImageTokens(clean)).toBe(clean);
  });
});

/**
 * Verbatim from the live Chai Point build (deepseek-v4-flash, NEXTJS): the model
 * put every picture request in its conversational reply instead of in a `src`, so
 * the pipeline had nothing to rewrite — and the customer read four lines of
 * internal protocol as the assistant's first message.
 */
const PROSE_REPLY = `I have built the Chai Point landing page with a warm terracotta palette.

NEED_IMAGE: Interior of a cozy tea cafe with warm lighting, wooden tables and hanging tea cups | 16:9 | Hero background
NEED_IMAGE: Close-up of a glass cup of masala chai with spices visible, warm terracotta tones | 1:1 | About section
NEED_IMAGE: Wide shot of a tea cafe counter with brass kettle and ceramic cups | 16:9 | Menu section background
NEED_IMAGE: Open graph image with Chai Point branding on warm terracotta background | 1200x630

Let me know if you want a different colour direction.`;

describe('a request written as prose is still a request', () => {
  it('parses every prose-written directive', () => {
    const directives = parseNeedImageDirectives(PROSE_REPLY);

    expect(directives).toHaveLength(4);
    expect(directives[0].description).toContain('cozy tea cafe');
  });

  it('reads the aspect past a trailing placement note', () => {
    // `… | 1:1 | About section`: the suffix group accepts `|`, so the whole tail used
    // to reach the matcher, fail it, and fall back to the 16:9 default — a square
    // portrait quietly reframed as landscape on every prose-written request.
    const aspects = parseNeedImageDirectives(PROSE_REPLY).map((directive) => directive.aspect);

    expect(aspects).toEqual(['16:9', '1:1', '16:9', '1200x630']);
  });

  it('never leaves protocol in the assistant message', () => {
    const chat = stripNeedImageTokens(PROSE_REPLY);

    expect(chat).not.toContain('NEED_IMAGE');
    // Unlike a stored file, chat gets no placeholder: the line was never speech.
    expect(chat).not.toContain('data:image/svg+xml');
    expect(chat).toContain('warm terracotta palette');
    expect(chat).toContain('different colour direction');
  });

  it('drops a bulleted or numbered request line whole', () => {
    const chat = stripNeedImageTokens(
      [
        'Images I need:',
        '- NEED_IMAGE: hero shot | 16:9',
        '1. NEED_IMAGE: og card | 1200x630',
      ].join('\n'),
    );

    expect(chat).toBe('Images I need:');
  });

  it('keeps a sentence that merely contains a request', () => {
    const chat = stripNeedImageTokens('The hero uses NEED_IMAGE: a roastery | 16:9 for now.');

    expect(chat).not.toContain('NEED_IMAGE');
    expect(chat).toContain('The hero uses');
  });

  it('leaves text with no token untouched', () => {
    const clean = 'All four sections are in place.';
    expect(stripNeedImageTokens(clean)).toBe(clean);
  });

  it('strips a prose request that contains an apostrophe, whole', () => {
    // Verbatim: the file-side terminator set stops at the first `'`, so only the
    // head came out and `- 's hands pouring chai | 1:1` rendered as the assistant's
    // chat message — the exact leak this strip exists to close.
    const chat = stripNeedImageTokens("- NEED_IMAGE: a barista's hands pouring chai | 1:1");

    expect(chat).toBe('');
  });

  it('strips a prose request that quotes a name, whole', () => {
    const chat = stripNeedImageTokens('- NEED_IMAGE: "Chai Point" storefront | 16:9');

    expect(chat).toBe('');
  });

  it('spends the credit on the whole subject at the aspect that was asked for', () => {
    // Same input read as a request rather than as text: the description used to stop
    // at the apostrophe and the aspect was lost with the rest of the line, so the
    // image credit bought "a barista" at the default 16:9.
    const [directive] = parseNeedImageDirectives(
      "- NEED_IMAGE: a barista's hands pouring chai | 1:1",
      'prose',
    );

    expect(directive.description).toBe("a barista's hands pouring chai");
    expect(directive.aspect).toBe('1:1');
  });

  it('keys a request by description and aspect, so one picture is bought once', () => {
    const [inFile] = parseNeedImageDirectives(
      '<img src="NEED_IMAGE: hero shot of a tea cafe | 16:9" />',
    );
    const [inProse] = parseNeedImageDirectives('NEED_IMAGE: Hero shot of a tea cafe | 16:9');

    expect(needImageKey(inFile)).toBe(needImageKey(inProse));
  });
});

/**
 * The quote in an attribute is a delimiter; a quote in the description is not.
 *
 * The terminator set exists because a token in a file sits inside `src="…"` and the
 * match must not eat the closing quote and the rest of the markup. It says nothing
 * about the *other* kind of quote, and an apostrophe inside a double-quoted `src`
 * used to cut the token in half: the sweep replaced the head and left
 * `src="data:…'s hands pouring chai | 1:1"` in the stored file.
 */
describe('a quote inside the description is description', () => {
  const FILE = `<img src="NEED_IMAGE: a barista's hands pouring chai | 1:1" alt="Chai" />`;

  it('reads the whole subject out of a double-quoted attribute', () => {
    const [directive] = parseNeedImageDirectives(FILE);

    expect(directive.description).toBe("a barista's hands pouring chai");
    expect(directive.aspect).toBe('1:1');
  });

  it('replaces the whole token and stops at the closing quote', () => {
    const swept = sweepNeedImageTokens(FILE);

    expect(swept).not.toContain('NEED_IMAGE');
    expect(swept).not.toContain("'s hands");
    // The attribute still closes, and the markup after it is untouched.
    expect(swept).toContain('" alt="Chai" />');
  });

  it('still stops a bare token before the next tag', () => {
    // Not inside an attribute, so the closing tag is the only thing that ends it.
    // Consuming to end of line here would swallow `</p>` and break the JSX.
    const swept = sweepNeedImageTokens('<p>NEED_IMAGE: a chai counter | 16:9</p>');

    expect(swept).not.toContain('NEED_IMAGE');
    expect(swept).toContain('</p>');
  });
});

/**
 * `… | 1:1` and `… | 1:1 | About section` are one picture asked for twice.
 *
 * Reading only the first `|`-separated field as the aspect made the two collapse to
 * the same key, the parser kept the first and dropped the second, and
 * `content.split(token).join(url)` then rewrote the second only as far as the text
 * they share: the About section shipped `src="https://cdn/x.png | About section"` —
 * a URL with a space in it that resolves to nothing, with no placeholder and no
 * entry in `unfulfilled`, because the `NEED_IMAGE:` marker the sweep looks for was
 * gone.
 */
const TWO_PLACEMENTS = [
  '<img src="NEED_IMAGE: cafe interior | 1:1">',
  '<img src="NEED_IMAGE: cafe interior | 1:1 | About section">',
].join('\n');

describe('one picture, both places that asked for it', () => {
  it('dedupes to a single request that remembers both occurrences', () => {
    const directives = parseNeedImageDirectives(TWO_PLACEMENTS);

    expect(directives).toHaveLength(1);
    expect(directives[0].aspect).toBe('1:1');
    expect(directives[0].tokens).toEqual([
      'NEED_IMAGE: cafe interior | 1:1',
      'NEED_IMAGE: cafe interior | 1:1 | About section',
    ]);
  });

  it('rewrites both occurrences in full', () => {
    const [directive] = parseNeedImageDirectives(TWO_PLACEMENTS);
    const resolved = replaceNeedImageTokens(
      TWO_PLACEMENTS,
      directive.tokens.map((token) => ({ token, url: 'https://cdn/x.png' })),
    );

    expect(resolved).toBe(
      '<img src="https://cdn/x.png">\n<img src="https://cdn/x.png">',
    );
  });

  it('placeholders both occurrences when nothing could fulfil them', () => {
    const resolved = replaceNeedImageTokens(TWO_PLACEMENTS, placeholderReplacements(TWO_PLACEMENTS));

    expect(resolved).not.toContain('NEED_IMAGE');
    // The annotation is part of the token, so it goes with it rather than being
    // left inside the `src` next to a URL.
    expect(resolved).not.toContain('About section');
    expect(resolved.match(/data:image\/svg\+xml/g)).toHaveLength(2);
  });

  it('rewrites every occurrence when the same request appears three times', () => {
    const thrice = [
      '<img src="NEED_IMAGE: cafe interior | 1:1">',
      '<img src="NEED_IMAGE: cafe interior | 1:1 | About section">',
      '<img src="NEED_IMAGE: Cafe Interior | 1:1 | Footer">',
    ].join('\n');
    const [directive] = parseNeedImageDirectives(thrice);
    const resolved = replaceNeedImageTokens(
      thrice,
      directive.tokens.map((token) => ({ token, url: 'https://cdn/x.png' })),
    );

    expect(parseNeedImageDirectives(thrice)).toHaveLength(1);
    expect(resolved).not.toContain('NEED_IMAGE');
    expect(resolved).not.toContain('Footer');
    expect(resolved.match(/https:\/\/cdn\/x\.png/g)).toHaveLength(3);
  });
});

describe('the shapes a model actually gets wrong', () => {
  it('takes a directive that ends with the input, with no trailing newline', () => {
    const [directive] = parseNeedImageDirectives(
      'Here is the plan.\nNEED_IMAGE: a chai counter | 4:5',
      'prose',
    );

    expect(directive.description).toBe('a chai counter');
    expect(directive.aspect).toBe('4:5');
  });

  it('buys nothing for an empty description but still never ships the token', () => {
    const empty = '<img src="NEED_IMAGE:   | 1:1">';

    expect(parseNeedImageDirectives(empty)).toEqual([]);
    expect(sweepNeedImageTokens(empty)).not.toContain('NEED_IMAGE');
  });

  it('bounds a runaway description before it becomes a provider prompt', () => {
    // An unterminated attribute makes the rest of the line the "description", and
    // that string is what reaches the image worker and the stock search.
    const runaway = `NEED_IMAGE: ${'a very long clause about chai '.repeat(60)}| 1:1`;
    const [directive] = parseNeedImageDirectives(runaway, 'prose');

    expect(directive.description.length).toBeLessThanOrEqual(300);
    expect(directive.description.startsWith('a very long clause about chai')).toBe(true);
    // Bounding the prompt must not stop the token itself being rewritten.
    expect(sweepNeedImageTokens(`<img src="${runaway}">`)).not.toContain('NEED_IMAGE');
  });

  it('separates two directives written on one line', () => {
    const directives = parseNeedImageDirectives(
      'NEED_IMAGE: a chai counter | 16:9 NEED_IMAGE: a masala chai glass | 1:1',
      'prose',
    );

    expect(directives).toHaveLength(2);
    expect(directives[1].description).toBe('a masala chai glass');
    expect(directives[1].aspect).toBe('1:1');
  });

  it('finishes on a pathological line instead of hanging the reply', () => {
    // The leftover-line test used to be two runs of the same character class either
    // side of an optional numbered marker, which has to try every split point before
    // it can fail: 20k characters cost 200ms, and this line costs minutes. It runs on
    // every line of every assistant reply.
    const line = `${' '.repeat(200_000)}x NEED_IMAGE: a chai counter | 16:9`;
    const chat = stripNeedImageTokens(line);

    expect(chat).not.toContain('NEED_IMAGE');
    expect(chat.trim()).toBe('x');
  });
});
