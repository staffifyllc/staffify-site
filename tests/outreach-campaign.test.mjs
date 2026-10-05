import test from 'node:test';
import assert from 'node:assert/strict';
import {CAMPAIGN_ID,tagCampaign} from '../api/_outreach-campaign.js';
import {eligible,callReady} from '../api/_outreach-policy.js';
import {sendDecision} from '../api/_outreach-send.js';
test('legacy records retain original membership and explicit campaigns are never reassigned',()=>{const s=tagCampaign({records:[{id:'old'},{id:'new',campaignId:'next-initiative'}]});assert.equal(s.records[0].campaignId,CAMPAIGN_ID);assert.equal(s.records[1].campaignId,'next-initiative');assert.equal(tagCampaign(s).campaigns.length,1);});
test('another campaign cannot draft, send or enter this dialer',()=>{const row={campaignId:'next-initiative',status:'prepared',sentTouches:0,bodyText:'hello',qualificationApproved:true};const state={pausedOwners:[],suppressions:[]};assert.equal(eligible(row,state),false);assert.equal(sendDecision(row,state,[],[]),'campaign_not_enabled_hold');assert.equal(callReady({...row,status:'sent',sentTouches:4,verifiedSentTouches:4,lastSentAt:'2026-01-01'}),false);});
