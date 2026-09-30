import {test} from 'node:test';
import assert from 'node:assert/strict';
import {copyIssue} from '../api/_outreach-copy.js';
test('known brand typo blocks body or subject',()=>{assert.ok(copyIssue({owner:'Paul',bodyText:'Flylisteopd'}));assert.ok(copyIssue({owner:'Paul',subject:'Flylisteopd'}));});
test('Madison cannot claim founder ownership',()=>{for(const bodyText of ['my own agency Flylisted','I built Flylisted','I founded Flylisted','I grew Flylisted','I am the founder of Flylisted'])assert.ok(copyIssue({owner:'Madison',bodyText}));});
test('accurate attribution and Paul story pass',()=>{assert.equal(copyIssue({owner:'Madison',bodyText:'Our CEO Paul built Flylisted.'}),null);assert.equal(copyIssue({owner:'Paul',bodyText:'I built Flylisted, my own agency.'}),null);});
test('quoted historic mistakes are not newly authored copy',()=>{assert.equal(copyIssue({owner:'Madison',bodyText:'Thanks for the update.\nOn Tuesday wrote:\nmy own agency Flylisteopd'}),null);});
