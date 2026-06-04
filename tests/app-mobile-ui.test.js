const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
const stylesSource = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');

test('mobile assignment tags open a touch-only move menu', () => {
  assert.match(appSource, /function\s+isMobileAssignmentMode\(\)/);
  assert.match(appSource, /matchMedia\('\(max-width:\s*1024px\)'\)/);
  assert.match(appSource, /matchMedia\('\(pointer:\s*coarse\)'\)/);
  assert.match(appSource, /function\s+showMobileAssignmentMenu\(name,\s*currentGroup\)/);
  assert.match(appSource, /assignment-move-modal/);
  assert.match(appSource, /movePersonToGroup\(name,\s*selectedGroup\)/);
  assert.match(appSource, /tag\.addEventListener\('click',\s*\(e\)\s*=>\s*{/);
});

test('phone layout stacks title images and tabs without changing desktop defaults', () => {
  assert.match(stylesSource, /\.tabs-side-img\s*{\s*width:\s*400px;\s*height:\s*200px;/);
  assert.match(stylesSource, /@media\s*\(max-width:\s*560px\)\s*{[\s\S]*body\s*{[\s\S]*background:\s*#101116;/);
  assert.match(stylesSource, /@media\s*\(max-width:\s*560px\)\s*{[\s\S]*\.app-header h1\s*{[\s\S]*transform:\s*none;/);
  assert.match(stylesSource, /@media\s*\(max-width:\s*560px\)\s*{[\s\S]*\.tabs-banner-row\s*{[\s\S]*grid-template-areas:\s*"left"\s*"right"\s*"tabs";/);
  assert.match(stylesSource, /@media\s*\(max-width:\s*560px\)\s*{[\s\S]*\.tabs-side-img\s*{[\s\S]*width:\s*min\(78vw,\s*320px\);[\s\S]*height:\s*clamp\(106px,\s*30vw,\s*144px\);/);
  assert.match(stylesSource, /@media\s*\(max-width:\s*560px\)\s*{[\s\S]*\.meal-tabs\s*{[\s\S]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\);/);
  assert.match(stylesSource, /@media\s*\(max-width:\s*560px\)\s*{[\s\S]*\.meal-tab\[data-tab="fridayLunch"\]\s*{[\s\S]*text-align:\s*center;/);
  assert.match(stylesSource, /@media\s*\(max-width:\s*560px\)\s*{[\s\S]*\.roulette-stage\s*{[\s\S]*width:\s*min\(100%,\s*360px\);/);
  assert.match(stylesSource, /@media\s*\(max-width:\s*560px\)\s*{[\s\S]*\.assignment-move-modal\s*{[\s\S]*background:\s*#1d1d22;/);
});

test('fold and tablet mobile layout has its own non-broken header and two-column content', () => {
  assert.match(stylesSource, /@media\s*\(min-width:\s*561px\)\s*and\s*\(max-width:\s*1024px\)\s*{[\s\S]*\.app-header h1\s*{[\s\S]*transform:\s*none;/);
  assert.match(stylesSource, /@media\s*\(min-width:\s*561px\)\s*and\s*\(max-width:\s*1024px\)\s*{[\s\S]*\.tabs-banner-row\s*{[\s\S]*grid-template-areas:\s*"left right"\s*"tabs tabs";/);
  assert.match(stylesSource, /@media\s*\(min-width:\s*561px\)\s*and\s*\(max-width:\s*1024px\)\s*{[\s\S]*\.tabs-side-img\s*{[\s\S]*transform:\s*none\s*!important;/);
  assert.match(stylesSource, /@media\s*\(min-width:\s*561px\)\s*and\s*\(max-width:\s*1024px\)\s*{[\s\S]*#panel-meal\s*{[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/);
  assert.match(stylesSource, /@media\s*\(min-width:\s*561px\)\s*and\s*\(max-width:\s*1024px\)\s*{[\s\S]*\.map-header h2\s*{[\s\S]*white-space:\s*nowrap;/);
});
