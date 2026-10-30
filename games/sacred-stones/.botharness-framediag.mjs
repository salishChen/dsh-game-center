import {readFileSync} from 'node:fs';
const s = JSON.parse(readFileSync('../../.botharness/frame-oracle/frame900-summary.json', 'utf8'));
console.log('firstDiff', JSON.stringify(s.diff.firstDiff));
console.log('maxChannelDelta', s.diff.maxChannelDelta, 'diff', s.diff.diffPixels);
