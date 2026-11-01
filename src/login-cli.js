#!/usr/bin/env node
// One-time sign-in: `npm run login`
import { interactiveLogin } from './browser.js';
console.log('A Chrome window opens. Sign in with your EDHEC account (waiting up to 5 min)...');
const r = await interactiveLogin();
console.log(JSON.stringify(r));
process.exit(r.blackboard ? 0 : 1);
