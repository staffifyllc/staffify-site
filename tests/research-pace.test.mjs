import test from 'node:test';
import assert from 'node:assert/strict';
import {researchPace} from '../api/_research-pace.js';
const now=Date.parse('2026-10-15T12:00:00Z');
const sample=(ago,used,renewal='2026-11-08')=>({startedAt:new Date(now-ago*3600000).toISOString(),budget:{used,renewal,remaining:14000,days:25,requiredDailyTarget:560}});
test('provider usage determines sustained pace',()=>{assert.equal(researchPace([sample(4,100),sample(0,110)],now).status,'behind');assert.equal(researchPace([sample(4,100),sample(0,200)],now).dailyRate,600);assert.equal(researchPace([sample(4,100),sample(0,200)],now).status,'on_pace');});
test('warmup, missing history and renewal never produce false pace alarms',()=>{assert.equal(researchPace([],now).status,'unknown');assert.equal(researchPace([sample(1,100),sample(0,110)],now).status,'measuring');assert.equal(researchPace([sample(4,100,'2026-10-08'),sample(0,10)],now).status,'measuring');});
