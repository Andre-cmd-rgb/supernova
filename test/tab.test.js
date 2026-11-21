'use strict';
// A tab going to sleep (frozen, then discarded) and waking up, through its
// methods and its page's events, with a fake Electron view in place of a page.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.states = []; // Page.setWebLifecycleState calls, in order
    this.hold = false; // when set, the next lifecycle change waits for release()
    this.release = null;
    this.closed = false;
    this.navigationHistory = { canGoBack: () => false, canGoForward: () => false };
    this.debugger = {
      isAttached: () => true,
      attach() {},
      detach() {},
      sendCommand: (_cmd, params) => {
        this.states.push(params.state);
        if (!this.hold) return Promise.resolve();
        this.hold = false;
        return new Promise((resolve) => { this.release = resolve; });
      },
    };
  }

  isDestroyed() { return this.closed; }
  isCurrentlyAudible() { return false; }
  getURL() { return 'https://example.com/'; }
  loadURL() { return Promise.resolve(); }
  setAudioMuted() {}
  close() { this.closed = true; this.emit('destroyed'); }
}

class FakeView {
  constructor() { this.webContents = new FakeWebContents(); }
  setBackgroundColor() {}
}

// tab.js loads Electron at the top; give it the fake view instead.
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === 'electron' ? { WebContentsView: FakeView } : load.call(this, request, ...rest);
};
const { Tab } = require('../src/main/tab');
Module._load = load;

const MIN = 60 * 1000;
const policy = { freezeMs: 10 * MIN, discardMs: 120 * MIN };
const made = [];
const newTab = () => {
  const tab = new Tab({ session: {}, url: 'https://example.com/', adopt: {}, hooks: { policy: () => policy } });
  made.push(tab);
  return tab;
};
// Its sleep timers (minutes long) would keep the test process alive.
test.afterEach(() => { for (const tab of made.splice(0)) tab.destroy(); });
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a tab shown while its freeze is on its way is not left frozen', async () => {
  const tab = newTab();
  const wc = tab.webContents;
  tab.hidden();
  wc.hold = true;
  const freezing = tab.freeze();
  await tab.shown(); // not frozen yet: nothing for shown() to undo
  wc.release();
  await freezing;
  assert.deepEqual(wc.states, ['frozen', 'active']);
  assert.equal(tab.frozen, false);
});

test('shown and hidden again during the freeze: still undone, frozen later', async () => {
  const tab = newTab();
  const wc = tab.webContents;
  tab.hidden();
  wc.hold = true;
  const freezing = tab.freeze();
  await tab.shown();
  tab.hidden();
  wc.release();
  await freezing;
  assert.deepEqual(wc.states, ['frozen', 'active'], 'the page is not left frozen behind the flag\'s back');
  assert.equal(tab.frozen, false);
  await tab.freeze();
  assert.equal(tab.frozen, true);
});

test('a tab discarded while its freeze is on its way is not marked frozen', async () => {
  const tab = newTab();
  const wc = tab.webContents;
  tab.hidden();
  wc.hold = true;
  const freezing = tab.freeze();
  tab.discard();
  wc.release();
  await freezing;
  assert.equal(tab.discarded, true);
  assert.equal(tab.frozen, false);
});

test('music paused after hours in the background: the tab sleeps on from then', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const tab = newTab();
  const wc = tab.webContents;
  tab.hidden();
  const hiddenAt = tab.lastShown;
  wc.emit('media-started-playing');
  t.mock.timers.tick(180 * MIN);
  await settle();
  assert.equal(tab.discarded, false, 'kept while it plays');
  assert.equal(tab.frozen, false);

  wc.emit('media-paused');
  t.mock.timers.tick(MIN);
  await settle();
  assert.equal(tab.discarded, false, 'not discarded the moment it went quiet');
  assert.equal(tab.lastShown, hiddenAt, 'the command bar\'s order is not touched');

  t.mock.timers.tick(10 * MIN);
  await settle();
  assert.equal(tab.frozen, true, 'frozen ten minutes after it went quiet');
  t.mock.timers.tick(110 * MIN);
  await settle();
  assert.equal(tab.discarded, true, 'discarded two hours after it went quiet');
});

test('a tab the user typed into is frozen but never discarded until it navigates', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const tab = newTab();
  tab.edited = true;
  tab.hidden();
  t.mock.timers.tick(200 * MIN);
  await settle();
  assert.equal(tab.discarded, false);
  tab.webContents.emit('did-navigate', {}, 'https://example.com/next');
  assert.equal(tab.edited, false);
});
