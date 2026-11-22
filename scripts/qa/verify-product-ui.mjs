import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import electron from 'electron';
import assert from 'node:assert/strict';
import { createQaDirectory } from '../lib/qa-directory.mjs';
const directory = createQaDirectory('product-ui'),
  pause = (ms) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const env = { ...process.env };
for (const k of Object.keys(env))
  if (k.startsWith('FOX_VERIFY_') || ['ELECTRON_RUN_AS_NODE', 'FOX_DEV_URL'].includes(k))
    delete env[k];
Object.assign(env, { FOX_VERIFY_DIR: directory, FOX_VERIFY_MANUAL: '1' });
const child = spawn(
  electron,
  ['.', `--remote-debugging-port=${port}`, '--force-device-scale-factor=1'],
  { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
);
let log = '';
child.stderr.on('data', (b) => (log += b));
let ws;
const result = { directory, views: [], issues: [], checks: [] };
try {
  let page;
  for (let i = 0; i < 300; i++) {
    try {
      page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
        (p) => p.type === 'page',
      );
      if (page) break;
    } catch {}
    if (child.exitCode !== null) throw Error(log);
    await pause(50);
  }
  assert.ok(page);
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  };
  const command = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const key = ++id;
      pending.set(key, (m) =>
        m.error ? reject(Error(JSON.stringify(m.error))) : resolve(m.result),
      );
      ws.send(JSON.stringify({ id: key, method, params }));
    });
  const js = async (expression) => {
    const r = await command('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const until = async (expression) => {
    for (let i = 0; i < 200; i++) {
      if (await js(expression)) return;
      await pause(25);
    }
    throw Error('Timeout: ' + expression);
  };
  const api = (code) => js(`(async()=>{const fox=window.fox;${code}})()`);
  const tap = async (selector) => {
    const point = await js(`(() => {
      const target = document.querySelector(${JSON.stringify(selector)});
      if (!target || target.disabled) return null;
      const rect = target.getBoundingClientRect();
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      return target.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
    })()`);
    assert.ok(point, 'Control must be visible and accept a touch: ' + selector);
    await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  await until('document.querySelectorAll("[data-table-code]").length===27');
  result.initial = await api(
    'return {products:await fox.products.list(),tables:await fox.tables.list(),report:await fox.reports.getSalesReport("ALL")};',
  );
  for (const id of ['KAFE-1', 'CAJ-1', 'PIJE-1', 'UJE-1', 'ALKOOL-1']) {
    assert.ok(
      (
        await api(
          `const p=(await fox.products.list()).find(p=>p.id===${JSON.stringify(id)});return fox.products.update({...p,sellingPriceCents:100,purchaseCostCents:id==='CAJ-1'?null:50,trackInventory:true,lowStockThreshold:5,active:true});`.replace(
            "id==='CAJ-1'",
            JSON.stringify(id) + "==='CAJ-1'",
          ),
        )
      ).ok,
    );
    assert.ok(
      (
        await api(
          `return fox.inventory.addSupply({requestId:crypto.randomUUID(),productId:${JSON.stringify(id)},quantity:200});`,
        )
      ).ok,
    );
  }
  await js('location.reload()');
  await until('Boolean(document.querySelector("[data-order-product=KAFE-1]:not(:disabled)"))');
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1093,
    height: 614,
    deviceScaleFactor: 1.25,
    mobile: false,
  });
  await command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await tap('[data-table-code=M4]');
  await until('document.querySelector("#order-heading")?.textContent==="Tavolina B4"');
  await tap('[data-table-code=M5]');
  await until('document.querySelector("#order-heading")?.textContent==="Tavolina B5"');
  await until('Boolean(document.querySelector("[data-order-product=KAFE-1]:not(:disabled)"))');
  await tap('[data-order-product=KAFE-1]');
  await until('!!document.querySelector("[data-ops-save-order]:not(:disabled)")');
  const splitMetrics = () =>
    js(`(() => {
      const handle = document.querySelector("[data-order-split-handle]");
      const {x, y, width, height} = handle.getBoundingClientRect();
      return {
        x: x + width / 2, y: y + height / 2,
        catalog: document.querySelector(".ops-products").clientHeight,
        details: document.querySelector(".order-split-details").clientHeight,
        quantity: document.querySelector("[data-draft-quantity]")?.textContent,
        footer: document.querySelector("[data-ops-save-order]").getBoundingClientRect().bottom
      };
    })()`);
  const beforeDrag = await splitMetrics();
  const grip = { x: beforeDrag.x, y: beforeDrag.y };
  await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [grip] });
  await command('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: grip.x, y: grip.y + 40 }],
  });
  await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const afterDrag = await splitMetrics();
  assert.ok(
    afterDrag.catalog > beforeDrag.catalog && afterDrag.details < beforeDrag.details,
    JSON.stringify({ beforeDrag, afterDrag }),
  );
  assert.equal(afterDrag.quantity, '1');
  assert.equal(afterDrag.footer, beforeDrag.footer);
  await js('document.querySelector("[data-order-split-handle]").focus()');
  await command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowUp' });
  assert.ok((await splitMetrics()).catalog < afterDrag.catalog);
  result.checks.push('Touch and keyboard resize the order panes while retaining the draft');
  await tap('[data-ops-save-order]');
  await until('Boolean(document.querySelector("[data-order-item]"))');
  assert.ok(await js('Boolean(document.querySelector(".order-split-details .current-order"))'));
  assert.equal(await js('document.querySelector("[data-order-quantity]")?.textContent'), '1');
  await command('Emulation.setTouchEmulationEnabled', { enabled: false });
  result.checks.push('One touch per table, product and order confirmation at 125% scaling');
  await api(
    'const w=await fox.orders.addProduct({tableId:"M1",productId:"CAJ-1"});return fox.orders.completeOrder({orderId:w.data.order.id});',
  );
  const capture = async (name) =>
    fs.writeFileSync(
      path.join(directory, name + '.png'),
      Buffer.from((await command('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
    );
  const nav = async (name) => {
    await js(`document.querySelector('[data-nav=${name}]').click()`);
    await until(`Boolean(document.querySelector('[data-page=${name}]'))`);
    await pause(180);
  };
  for (const [width, height, scale] of [
    [1366, 768, 1],
    [1440, 900, 1],
    [1920, 1080, 1],
    [1093, 614, 1.25],
    [910, 512, 1.5],
  ]) {
    await command('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: scale,
      mobile: false,
    });
    for (const screen of ['tables', 'inventory', 'reports', 'settings']) {
      await nav(screen);
      await capture(`${screen}-${width}-${scale}`);
      const metrics = await js(
        `(()=>{const r=e=>{const b=e.getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height,visible:b.x>=0&&b.y>=0&&b.right<=innerWidth&&b.bottom<=innerHeight};};return {pageOverflow:document.documentElement.scrollWidth>innerWidth,buttons:[...document.querySelectorAll('.checkout-open,.panel-footer button')].map(r),tableCount:document.querySelectorAll('[data-table-code]').length,overlaps:(()=>{const a=[...document.querySelectorAll('[data-table-code]')];return a.flatMap((e,i)=>a.slice(i+1).filter(f=>{const b=e.getBoundingClientRect(),c=f.getBoundingClientRect();return b.left<c.right&&b.right>c.left&&b.top<c.bottom&&b.bottom>c.top;}).map(f=>[e.dataset.tableCode,f.dataset.tableCode]));})(),bodyText:document.querySelector('main').innerText};})()`,
      );
      result.views.push({ width, height, scale, screen, ...metrics });
      if (screen === 'tables') {
        assert.equal(metrics.tableCount, 27);
        assert.deepEqual(metrics.overlaps, []);
      }
      assert.equal(metrics.pageOverflow, false);
      if (metrics.pageOverflow)
        result.issues.push({ screen, width, scale, issue: 'Horizontal page overflow' });
      if (metrics.buttons.some((b) => !b.visible))
        result.issues.push({ screen, width, scale, issue: 'Critical footer outside viewport' });
      if (screen === 'tables') {
        await until('Boolean(document.querySelector("[data-open-checkout]:not(:disabled)"))');
        await js(
          '(()=>{const b=document.querySelector("[data-open-checkout]");b.focus();b.click();})()',
        );
        await until('Boolean(document.querySelector(".checkout-dialog[open]"))');
        await capture(`checkout-${width}-${scale}`);
        result.views.push({
          width,
          height,
          scale,
          screen: 'checkout',
          ...(await js(
            '(()=>{const b=document.querySelector(".checkout-dialog").getBoundingClientRect(),f=document.querySelector("[data-confirm-payment]").getBoundingClientRect();return {dialogHeight:b.height,dialogTop:b.top,confirmBottom:f.bottom,viewport:innerHeight,focus:document.activeElement.textContent};})()',
          )),
        });
        await command('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'Escape',
          code: 'Escape',
          windowsVirtualKeyCode: 27,
        });
        await command('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'Escape',
          code: 'Escape',
          windowsVirtualKeyCode: 27,
        });
        await until('!document.querySelector(".checkout-dialog[open]")');
      }
      if (screen === 'inventory') {
        await js('document.querySelector(".row-actions button").click()');
        await until('Boolean(document.querySelector("dialog[open]"))');
        await capture(`editor-${width}-${scale}`);
        await command('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'Escape',
          code: 'Escape',
          windowsVirtualKeyCode: 27,
        });
        await until('!document.querySelector("dialog[open]")');
      }
      if (screen === 'settings') {
        await js('document.querySelector(".data-protection").scrollIntoView({block:"end"})');
        await pause(150);
        await capture(`data-${width}-${scale}`);
      }
    }
  }

  // Golden workflow uses actual React controls, including form validation and double actions.
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1366,
    height: 768,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await nav('inventory');
  await js('document.querySelector(".row-actions button").click()');
  await until('Boolean(document.querySelector("#sellingPriceCents"))');
  const field = async (id, value) =>
    js(`(() => {
      const input = document.getElementById(${JSON.stringify(id)});
      const select = input instanceof HTMLSelectElement;
      const prototype = select ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event(select ? 'change' : 'input', { bubbles: true }));
    })()`);
  await field('sellingPriceCents', 'abc');
  await js('document.querySelector("button[form=product-form]").click()');
  await until('Boolean(document.querySelector("#sellingPriceCents[aria-invalid=true]"))');
  assert.equal(
    await api('return (await fox.products.list()).find(p=>p.id==="KAFE-1").sellingPriceCents;'),
    100,
  );
  await field('sellingPriceCents', '1,00');
  await field('purchaseCostCents', '0,50');
  await js(
    '(()=>{const b=document.querySelector("button[form=product-form]");b.click();b.click();})()',
  );
  await until('!document.querySelector("dialog[open]")');
  await js(
    '[...document.querySelectorAll("button")].find(b=>b.textContent.includes("Shto stok")).click()',
  );
  await until('Boolean(document.querySelector("#supply-form"))');
  await field('productId', 'KAFE-1');
  await field('quantity', '-5');
  await js('document.querySelector("button[form=supply-form]").click()');
  await until('Boolean(document.querySelector("#quantity[aria-invalid=true]"))');
  await field('quantity', '20');
  await js(
    '(()=>{const b=document.querySelector("button[form=supply-form]");b.click();b.click();})()',
  );
  await until('!document.querySelector("dialog[open]")');
  assert.equal(
    await api('return (await fox.products.list()).find(p=>p.id==="KAFE-1").stockQuantity;'),
    220,
  );
  await nav('tables');
  await until('Boolean(document.querySelector("[data-order-item]"))');
  await js(
    '(()=>{for(const code of ["M1","M4","T3","M5"])document.querySelector("[data-table-code="+code+"]").click();})()',
  );
  await until(
    'document.querySelector("#order-heading")?.textContent==="Tavolina B5" && document.querySelector("[data-order-quantity]")?.textContent==="1"',
  );
  await js(
    '(()=>{for(const c of ["CAJ","PIJE","KAFE"])document.querySelector("[data-order-category="+c+"]").click();})()',
  );
  await js(
    '(()=>{const b=document.querySelector("button[aria-label^=Rrit]");b.click();b.click();})()',
  );
  await until('document.querySelector("[data-order-quantity]")?.textContent==="2"');
  await js(
    '(()=>{const b=document.querySelector("button[aria-label^=Ul]");b.click();b.click();})()',
  );
  await until('document.querySelector("[data-order-quantity]")?.textContent==="1"');
  await js('(()=>{const b=document.querySelector("[data-open-checkout]");b.focus();b.click();})()');
  await until('Boolean(document.querySelector("dialog[open]"))');
  assert.equal(await js('document.activeElement.hasAttribute("data-cancel-payment")'), true);
  await command('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Tab',
    code: 'Tab',
    windowsVirtualKeyCode: 9,
  });
  assert.equal(await js('document.activeElement.hasAttribute("data-confirm-payment")'), true);
  await command('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
  });
  await until('!document.querySelector("dialog[open]")');
  assert.equal(await js('document.activeElement.hasAttribute("data-open-checkout")'), true);
  await js('(()=>{const b=document.querySelector("[data-open-checkout]");b.focus();b.click();})()');
  await until('Boolean(document.querySelector("dialog[open]"))');
  await js(
    '(()=>{const b=document.querySelector("[data-confirm-payment]");b.click();b.click();})()',
  );
  await until(
    '!document.querySelector("dialog[open]") && !document.querySelector("[data-order-item]")',
  );
  const paid = await api(
    'return {report:await fox.reports.getSalesReport("ALL"),product:(await fox.products.list()).find(p=>p.id==="KAFE-1"),table:(await fox.tables.list()).find(t=>t.code==="M5")};',
  );
  assert.equal(paid.report.summary.completedOrders, 2);
  assert.equal(paid.report.summary.salesCents, 200);
  assert.equal(paid.report.cashCents, 200);
  assert.equal(paid.product.stockQuantity, 219);
  assert.equal(paid.table.status, 'FREE');
  result.golden = {
    passed: true,
    reactFormValidation: true,
    commaMoneyInput: true,
    doubleSaveSupplyQuantityCheckout: true,
    rapidSwitches: true,
    safeEscapeFocusRestore: true,
    stock: 219,
    revenueCents: 200,
  };
  // Large isolated values and a full catalogue order must keep confirmation usable.
  const all = await api('return fox.products.list();');
  for (const p of all) {
    await api(
      'return fox.products.update({...' +
        JSON.stringify(p) +
        ',sellingPriceCents:99999,purchaseCostCents:50,trackInventory:false,active:true});',
    );
    assert.ok(
      (
        await api(
          'return fox.orders.addProduct({tableId:"M5",productId:' + JSON.stringify(p.id) + '});',
        )
      ).ok,
    );
  }
  for (let i = 1; i < 99; i++)
    assert.ok(
      (
        await api(
          'const w=await fox.orders.getForTable("M5");return fox.orders.incrementItem({tableId:"M5",itemId:w.order.items[0].id});',
        )
      ).ok,
    );
  const long = await api('return (await fox.products.list())[0];');
  assert.ok(
    (
      await api(
        'return fox.products.update({...' +
          JSON.stringify(long) +
          ',name:' +
          JSON.stringify('QA long product name '.repeat(9).slice(0, 190)) +
          ',trackInventory:true});',
      )
    ).ok,
  );
  assert.ok(
    (
      await api(
        'return fox.inventory.addSupply({requestId:crypto.randomUUID(),productId:"KAFE-1",quantity:99999});',
      )
    ).ok,
  );
  await nav('inventory');
  await nav('tables');
  await until('document.querySelectorAll("[data-order-item]").length===21');
  for (const [width, height, scale] of [
    [1366, 768, 1],
    [1093, 614, 1.25],
    [910, 512, 1.5],
  ]) {
    await command('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: scale,
      mobile: false,
    });
    await js(
      '(()=>{const b=document.querySelector("[data-open-checkout]");b.focus();b.click();})()',
    );
    await until('Boolean(document.querySelector("dialog[open]"))');
    const rect = await js(
      '(()=>{const b=document.querySelector("[data-confirm-payment]").getBoundingClientRect(),h=document.querySelector(".checkout-dialog h2").getBoundingClientRect();return {top:h.top,bottom:b.bottom,height:innerHeight};})()',
    );
    assert.ok(rect.top >= 0 && rect.bottom <= rect.height);
    await capture('checkout-many-' + width);
    await js('document.querySelector("[data-cancel-payment]").click()');
    await until('!document.querySelector("dialog[open]")');
  }
  result.edgeValues = {
    quantity: 99,
    stockAbove99999: true,
    priceCents: 99999,
    longName: true,
    lines: 21,
    paymentActionsVisible: true,
  };
  // Use a product on the open order, so removing it cannot rely on deleting the database row.
  await nav('inventory');
  const openProduct = () => js('document.querySelector(".row-actions button").click()');
  await openProduct();
  await tap('[data-remove-product]');
  await until('Boolean(document.querySelector("[data-confirm-product-removal]"))');
  await tap('dialog[open] [data-initial-focus]');
  await until('Boolean(document.querySelector("#product-form"))');
  assert.ok(await api('return (await fox.products.list()).some(p=>p.id==="KAFE-1");'));
  await tap('dialog[open] [aria-label="Mbyll panelin"]');
  await until('!document.querySelector("dialog[open]")');
  const revealRemoval = () =>
    js(
      'document.querySelector(\'[data-remove-product-row="KAFE-1"]\').scrollIntoView({block:"center",inline:"nearest"})',
    );
  for (const [width, height, scale] of [
    [1366, 768, 1],
    [1093, 614, 1.25],
    [910, 512, 1.5],
  ]) {
    await command('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: scale,
      mobile: false,
    });
    await revealRemoval();
    await tap('[data-remove-product-row="KAFE-1"]');
    await until('Boolean(document.querySelector("[data-confirm-product-removal]"))');
    assert.equal(await js('Boolean(document.querySelector("#product-form"))'), false);
    await tap('dialog[open] [data-initial-focus]');
    await until('Boolean(document.querySelector("#product-form"))');
    assert.ok(await api('return (await fox.products.list()).some(p=>p.id==="KAFE-1");'));
    await tap('dialog[open] [aria-label="Mbyll panelin"]');
    await until('!document.querySelector("dialog[open]")');
  }
  await revealRemoval();
  await tap('[data-remove-product-row="KAFE-1"]');
  await tap('[data-confirm-product-removal]');
  await until(
    '!document.querySelector("dialog[open]") && document.querySelectorAll(".catalog tbody tr").length===20',
  );
  assert.equal(await api('return (await fox.products.list()).some(p=>p.id==="KAFE-1");'), false);
  await nav('tables');
  assert.equal(await js('Boolean(document.querySelector("[data-order-product=KAFE-1]"))'), false);
  await until('document.querySelectorAll("[data-order-item]").length===21');
  assert.equal(
    await api('return (await fox.reports.getSalesReport("ALL")).summary.salesCents;'),
    200,
  );
  result.checks.push(
    'Direct stock product removal supports cancel and preserves recorded orders and sales',
  );
  const openOrder = await api('return fox.orders.getForTable("M5");');
  assert.equal(openOrder.order.status, 'OPEN');
  await nav('inventory');
  await tap('[data-page=inventory] .page-actions .button-primary');
  await until('Boolean(document.querySelector(\'#productId option[value="new-product"]\'))');
  await field('productId', 'new-product');
  await until('Boolean(document.querySelector("#new-product-name"))');
  await field('new-product-category', 'UJE');
  await field('quantity', '24');
  assert.equal(await js('document.querySelector("#new-product-category").value'), 'UJE');
  assert.equal(await js('document.querySelector("#quantity").value'), '24');
  assert.equal(
    await js('document.querySelector("button[form=supply-form]").textContent.trim()'),
    'Ruaj produktin dhe stokun',
  );
  await tap('button[form=supply-form]');
  await until('Boolean(document.querySelector("#new-product-name[aria-invalid=true]"))');
  const productName = 'Ujë prove QA';
  await field('new-product-name', productName);
  await js(
    '(()=>{const button=document.querySelector("button[form=supply-form]");button.click();button.click();})()',
  );
  const name = JSON.stringify(productName);
  await until(`!document.querySelector('dialog[open]') && [...document.querySelectorAll('.catalog tbody tr')].some(row =>
    row.querySelector('.product-name').textContent.trim() === ${name} &&
    row.querySelector('.stock-cell strong')?.textContent === '24')`);
  assert.equal(
    await js('document.querySelector(".table-caption [role=status]").textContent.trim()'),
    'Produkti i ri dhe stoku u ruajtën.',
  );
  const added = await api(
    `return (await fox.products.list()).filter(product => product.name === ${name});`,
  );
  assert.equal(added.length, 1);
  assert.equal(added[0].categoryId, 'UJE');
  assert.equal(added[0].stockQuantity, 24);
  assert.equal(added[0].trackInventory, true);
  assert.equal(added[0].sellingPriceCents, null);
  assert.equal(added[0].purchaseCostCents, null);
  assert.deepEqual(await api('return fox.orders.getForTable("M5");'), openOrder);
  result.checks.push('Owner can create a stock product once while preserving the open table order');
  await command('HeapProfiler.collectGarbage');
  result.dom = await command('Memory.getDOMCounters');
  const logDirectory = path.join(directory, 'logs');
  const logFiles = fs.readdirSync(logDirectory).filter((n) => n.endsWith('.log'));
  const logBytes = logFiles.reduce((n, f) => n + fs.statSync(path.join(logDirectory, f)).size, 0);
  assert.equal(logBytes, 0, 'Normal workflow must not log errors');
  result.normalLogs = { files: logFiles.length, bytes: logBytes };
  result.passed = true;
  fs.writeFileSync(path.join(directory, 'audit-result.json'), JSON.stringify(result, null, 2));
  // Closing the last page can disconnect CDP before its response is delivered.
  // Verify the actual process exit instead of awaiting that disappearing response.
  const closed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Electron did not close after UI audit')), 10000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(Error('UI audit Electron exit: ' + code));
    });
  });
  ws.send(JSON.stringify({ id: ++id, method: 'Page.close' }));
  await closed;
  ws.close();
  console.log(directory);
} catch (e) {
  ws?.close();
  if (child.exitCode === null)
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  throw e;
}
