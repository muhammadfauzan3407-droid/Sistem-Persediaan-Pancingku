const state = {
  products: [],
  movements: [],
  categories: [],
  suppliers: [],
  remote: false,
  view: 'dashboard',
  supabase: null,
  session: null,
  apiMode: 'backend',
};

const AUTH_SESSION_KEY = 'pancingku-auth-session';
const DEFAULT_SUPABASE = {
  url: 'https://jgozamfkazsgcuoihael.supabase.co',
  publishableKey: 'sb_publishable_G1UqqY5wrcHQyA0Eur1yvQ_To_yqsTj',
};
const money = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 });
const number = new Intl.NumberFormat('id-ID');
const byId = (id) => document.getElementById(id);
const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const getCategoryName = (product) => product.category?.name || product.category_name || '';
const getSupplierName = (product) => product.supplier?.name || product.supplier_name || '';

function localData() {
  try {
    const saved = JSON.parse(localStorage.getItem('pancingku-inventory') || '{}');
    return {
      products: saved.products || [],
      movements: saved.movements || [],
      categories: saved.categories || [],
      suppliers: saved.suppliers || [],
    };
  } catch {
    return { products: [], movements: [], categories: [], suppliers: [] };
  }
}

function saveLocal() {
  localStorage.setItem('pancingku-inventory', JSON.stringify({
    products: state.products,
    movements: state.movements,
    categories: state.categories,
    suppliers: state.suppliers,
  }));
}

function showLogin(message = '') {
  byId('app-shell').hidden = true;
  byId('auth-screen').hidden = false;
  byId('auth-message').textContent = message;
}

function showApp() {
  byId('auth-screen').hidden = true;
  byId('app-shell').hidden = false;
}

function clearSession() {
  state.session = null;
  localStorage.removeItem(AUTH_SESSION_KEY);
}

function storeSession(session) {
  state.session = session;
  localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(session));
}

async function authRequest(path, body, accessToken = '') {
  const response = await fetch(`${state.supabase.url}/auth/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: state.supabase.publishableKey,
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.msg || payload.message || payload.error_description || 'Autentikasi gagal.');
  return payload;
}

async function refreshSession() {
  if (!state.session?.refresh_token) throw new Error('Sesi login berakhir. Silakan masuk kembali.');
  const refreshed = await authRequest('token?grant_type=refresh_token', { refresh_token: state.session.refresh_token });
  storeSession(refreshed);
}

function apiResult(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

async function directSupabase(path, options = {}) {
  const response = await fetch(`${state.supabase.url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: state.supabase.publishableKey,
      Authorization: `Bearer ${state.session.access_token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.message || payload?.details || 'Permintaan ke Supabase gagal.');
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function directApiRequest(path, options = {}) {
  const url = new URL(path, 'http://pancingku.local');
  const method = options.method || 'GET';
  if (url.pathname === '/api/status') return apiResult({ connected: true });
  if (url.pathname === '/api/auth/config') return apiResult(state.supabase);
  if (!state.session?.access_token) return apiResult({ message: 'Silakan login terlebih dahulu.' }, 401);

  if (url.pathname === '/api/dashboard' && method === 'GET') {
    const [products, movements] = await Promise.all([
      directSupabase('products?select=id,sku,name,unit,current_stock,min_stock,cost_price,selling_price,category:categories(name),supplier:suppliers(name)&order=current_stock.asc'),
      directSupabase('stock_movements?select=id,movement_type,quantity,note,created_at,product:products(name,sku)&order=created_at.desc,id.desc&limit=8'),
    ]);
    return apiResult({
      products,
      movements,
      stats: {
        productCount: products.length,
        categoryCount: new Set(products.map((product) => product.category?.name).filter(Boolean)).size,
        totalUnits: products.reduce((sum, product) => sum + Number(product.current_stock), 0),
        lowStockCount: products.filter((product) => product.current_stock <= product.min_stock).length,
        inventoryValue: products.reduce((sum, product) => sum + product.current_stock * Number(product.cost_price), 0),
      },
    });
  }

  if (url.pathname === '/api/products' && method === 'GET') {
    const search = url.searchParams.get('search');
    const filter = search ? `&or=(name.ilike.*${encodeURIComponent(search)}*,sku.ilike.*${encodeURIComponent(search)}*)` : '';
    return apiResult(await directSupabase(`products?select=*,category:categories(id,name),supplier:suppliers(id,name)&order=name.asc${filter}`));
  }
  if (url.pathname === '/api/products' && method === 'POST') {
    return apiResult(await directSupabase('rpc/create_product', { method: 'POST', body: JSON.stringify({ product_data: JSON.parse(options.body) }) }), 201);
  }

  const productMatch = url.pathname.match(/^\/api\/products\/([0-9a-f-]+)$/i);
  if (productMatch && method === 'PATCH') {
    return apiResult(await directSupabase('rpc/update_product', {
      method: 'POST', body: JSON.stringify({ product_id: productMatch[1], product_data: JSON.parse(options.body) }),
    }));
  }
  if (productMatch && method === 'DELETE') {
    return apiResult(await directSupabase('rpc/delete_product', {
      method: 'POST', body: JSON.stringify({ product_id: productMatch[1] }),
    }));
  }

  if (url.pathname === '/api/movements' && method === 'GET') {
    return apiResult(await directSupabase('stock_movements?select=*,product:products(id,name,sku,unit)&order=created_at.desc,id.desc&limit=100'));
  }
  if (url.pathname === '/api/movements' && method === 'POST') {
    return apiResult(await directSupabase('rpc/record_stock_movement', {
      method: 'POST', body: JSON.stringify({ movement_data: JSON.parse(options.body) }),
    }), 201);
  }
  const movementMatch = url.pathname.match(/^\/api\/movements\/([0-9a-f-]+)$/i);
  if (movementMatch && method === 'PATCH') {
    return apiResult(await directSupabase('rpc/update_stock_movement', {
      method: 'POST', body: JSON.stringify({ movement_id: movementMatch[1], movement_data: JSON.parse(options.body) }),
    }));
  }
  if (movementMatch && method === 'DELETE') {
    return apiResult(await directSupabase('rpc/delete_stock_movement', {
      method: 'POST', body: JSON.stringify({ movement_id: movementMatch[1] }),
    }));
  }

  const masterMatch = url.pathname.match(/^\/api\/(categories|suppliers)(?:\/([0-9a-f-]+))?$/i);
  if (masterMatch) {
    const [, table, id] = masterMatch;
    if (!id && method === 'GET') return apiResult(await directSupabase(`${table}?select=*&order=name.asc`));
    if (!id && method === 'POST') {
      const rows = await directSupabase(table, { method: 'POST', headers: { Prefer: 'return=representation' }, body: options.body });
      return apiResult(rows[0], 201);
    }
    if (id && method === 'PATCH') {
      const rows = await directSupabase(`${table}?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: options.body });
      return rows.length ? apiResult(rows[0]) : apiResult({ message: 'Data master tidak ditemukan.' }, 404);
    }
    if (id && method === 'DELETE') {
      await directSupabase(`${table}?id=eq.${id}`, { method: 'DELETE' });
      return apiResult({ ok: true });
    }
  }

  return apiResult({ message: 'Rute tidak ditemukan.' }, 404);
}

async function request(path, options = {}, retryAuth = true) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.session?.access_token) headers.Authorization = `Bearer ${state.session.access_token}`;
  const response = state.apiMode === 'direct'
    ? await directApiRequest(path, { ...options, headers }).catch((error) => apiResult({ message: error.message }, error.status || 500))
    : await fetch(path, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401 && retryAuth && state.session?.refresh_token) {
    try {
      await refreshSession();
      return request(path, options, false);
    } catch {
      clearSession();
      showLogin('Sesi login berakhir. Silakan masuk kembali.');
    }
  }
  if (!response.ok) throw new Error(payload.message || 'Permintaan tidak berhasil.');
  return payload;
}

function setConnection(kind, text) {
  const node = byId('connection-state');
  node.className = `connection ${kind}`;
  node.querySelector('span').textContent = text;
  node.title = text;
}

async function loadData() {
  const status = await request('/api/status');
  if (!status.connected) {
    enterLocalMode();
    return;
  }

  const [dashboard, categories, suppliers, movements] = await Promise.all([
    request('/api/dashboard'),
    request('/api/categories'),
    request('/api/suppliers'),
    request('/api/movements'),
  ]);
  state.remote = true;
  state.products = dashboard.products || [];
  state.movements = movements || [];
  state.categories = categories;
  state.suppliers = suppliers;
  setConnection('online', 'Supabase terhubung');
  render();
}

function enterLocalMode() {
  const saved = localData();
  state.remote = false;
  state.products = saved.products;
  state.movements = saved.movements;
  state.categories = saved.categories.length ? saved.categories : collectMasters(state.products, 'category');
  state.suppliers = saved.suppliers.length ? saved.suppliers : collectMasters(state.products, 'supplier');
  setConnection('local', 'Mode lokal · belum tersambung Supabase');
  showApp();
  render();
}

async function initializeAuth() {
  state.session = null;
  if (window.location.protocol === 'file:') {
    state.supabase = DEFAULT_SUPABASE;
    state.apiMode = 'direct';
  } else {
    try {
      state.supabase = await request('/api/auth/config');
      state.apiMode = 'backend';
    } catch {
      state.apiMode = 'direct';
      state.supabase = DEFAULT_SUPABASE;
    }
  }

  try {
    state.session = JSON.parse(localStorage.getItem(AUTH_SESSION_KEY) || 'null');
  } catch {
    clearSession();
  }
  if (!state.session?.access_token) {
    showLogin();
    return;
  }

  byId('user-email').textContent = state.session.user?.email || '';
  showApp();
  try {
    await loadData();
  } catch (error) {
    clearSession();
    showLogin(error.message || 'Sesi login tidak berlaku. Silakan masuk kembali.');
  }
}

async function signIn(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  byId('auth-message').textContent = 'Memeriksa akun...';
  try {
    const session = await authRequest('token?grant_type=password', {
      email: form.elements.email.value.trim(),
      password: form.elements.password.value,
    });
    storeSession(session);
    byId('user-email').textContent = session.user?.email || '';
    showApp();
    await loadData();
    form.reset();
  } catch (error) {
    clearSession();
    const message = error.message.toLowerCase();
    showLogin(message.includes('invalid login credentials')
      ? 'Supabase menolak login. Pastikan email terdaftar di project ini dan status Email Confirmed aktif. Error ini juga bisa berarti password tidak cocok.'
      : message.includes('email not confirmed')
        ? 'Email belum dikonfirmasi. Buka tautan konfirmasi dari email Supabase atau aktifkan Email Confirmed di Authentication > Users.'
        : error.message);
  } finally {
    submit.disabled = false;
  }
}

async function signOut() {
  if (state.session?.access_token && state.supabase) {
    try {
      await authRequest('logout', {}, state.session.access_token);
    } catch {
      // Clear the local session even if the network is unavailable.
    }
  }
  clearSession();
  state.remote = false;
  byId('login-form').reset();
  showLogin();
}

function collectMasters(products, kind) {
  const getName = kind === 'category' ? getCategoryName : getSupplierName;
  const names = [...new Set(products.map(getName).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'id'));
  return names.map((name) => ({ id: name, name }));
}

function ensureLocalMaster(table, name) {
  const value = name.trim();
  if (!value) return;
  const list = table === 'categories' ? state.categories : state.suppliers;
  if (!list.some((item) => item.name.toLocaleLowerCase('id') === value.toLocaleLowerCase('id'))) {
    list.push({ id: crypto.randomUUID(), name: value });
  }
}

function getStats() {
  return {
    productCount: state.products.length,
    categoryCount: state.categories.length,
    totalUnits: state.products.reduce((total, product) => total + Number(product.current_stock || 0), 0),
    lowStockCount: state.products.filter((product) => Number(product.current_stock) <= Number(product.min_stock)).length,
    inventoryValue: state.products.reduce((total, product) => total + Number(product.current_stock || 0) * Number(product.cost_price || 0), 0),
  };
}

function render() {
  renderStats();
  renderLowStock();
  renderRecentMovements();
  renderProducts();
  renderMovements();
  renderMasters();
  updateProductOptions();
  byId('product-count').textContent = number.format(state.products.length);
}

function renderStats() {
  const stats = getStats();
  byId('stat-products').textContent = number.format(stats.productCount);
  byId('stat-categories').textContent = number.format(stats.categoryCount);
  byId('stat-units').textContent = number.format(stats.totalUnits);
  byId('stat-low').textContent = number.format(stats.lowStockCount);
  byId('stat-value').textContent = money.format(stats.inventoryValue);
}

function renderLowStock() {
  const sorted = [...state.products].sort((a, b) => Number(a.current_stock) - Number(b.current_stock)).slice(0, 4);
  const list = byId('low-stock-list');
  if (!sorted.length) {
    list.innerHTML = '<div class="quiet-state"><span>▤</span>Belum ada produk. Tambahkan produk pertama toko Anda.</div>';
    return;
  }
  list.innerHTML = sorted.map((product) => `
    <div class="stock-row"><div><div class="stock-name">${escapeHtml(product.name)}</div><div class="stock-sku">${escapeHtml(product.sku)}</div></div>
    <div class="stock-amount ${Number(product.current_stock) <= Number(product.min_stock) ? 'low' : ''}">${number.format(product.current_stock)} ${escapeHtml(product.unit || 'pcs')}</div></div>`).join('');

  const restock = state.products.filter((product) => Number(product.current_stock) <= Number(product.min_stock));
  byId('restock-count').textContent = `${restock.length} item`;
  byId('restock-list').innerHTML = restock.length
    ? restock.slice(0, 5).map((product) => `<div class="restock-item"><i class="restock-dot"></i><span>${escapeHtml(product.name)}</span><strong>${number.format(product.current_stock)} ${escapeHtml(product.unit || 'pcs')}</strong></div>`).join('')
    : '<div class="quiet-state"><span class="check">✓</span>Semua stok berada di atas batas minimum.</div>';
}

function movementLabel(type) {
  return type === 'IN' ? 'Masuk' : type === 'OUT' ? 'Keluar' : 'Penyesuaian';
}

function movementClass(type) {
  return type === 'IN' ? 'in' : type === 'OUT' ? 'out' : 'adjust';
}

function movementProduct(movement) {
  return movement.product?.name || state.products.find((product) => product.id === movement.product_id)?.name || 'Produk';
}

function formatDate(value) {
  return new Intl.DateTimeFormat('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function renderRecentMovements() {
  const list = byId('recent-movements');
  const recent = state.movements.slice(0, 5);
  if (!recent.length) {
    list.innerHTML = '<div class="quiet-state">↕ Belum ada aktivitas mutasi stok.</div>';
    return;
  }
  list.innerHTML = recent.map((item) => `<div class="recent-row"><span class="recent-product">${escapeHtml(movementProduct(item))}</span><span class="recent-date">${escapeHtml(formatDate(item.created_at))}</span><span class="type-pill ${movementClass(item.movement_type)}">${movementLabel(item.movement_type)}</span><span class="recent-qty">${item.movement_type === 'OUT' ? '−' : '+'}${number.format(item.quantity)}</span></div>`).join('');
}

function renderProducts() {
  const query = byId('product-search').value.trim().toLocaleLowerCase('id');
  const filtered = state.products.filter((product) => `${product.name} ${product.sku}`.toLocaleLowerCase('id').includes(query));
  byId('product-results').textContent = `${filtered.length} produk`;
  byId('products-empty').classList.toggle('visible', state.products.length === 0);
  byId('products-table').closest('.table-scroll').style.display = state.products.length ? '' : 'none';
  byId('products-table').innerHTML = filtered.map((product) => {
    const isLow = Number(product.current_stock) <= Number(product.min_stock);
    return `<tr>
      <td><div class="product-cell"><span class="product-monogram">${escapeHtml(product.name.slice(0, 1))}</span><span class="product-primary"><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.sku)}</small></span></div></td>
      <td>${escapeHtml(getCategoryName(product) || 'Tanpa kategori')}</td>
      <td><span class="stock-chip ${isLow ? 'low' : ''}"><i></i>${number.format(product.current_stock)} ${escapeHtml(product.unit || 'pcs')}</span></td>
      <td>${money.format(product.cost_price || 0)}</td><td>${money.format(product.selling_price || 0)}</td>
      <td><span class="row-actions"><button class="row-action" data-edit-product="${escapeHtml(product.id)}" aria-label="Edit ${escapeHtml(product.name)}" title="Edit produk">✎</button><button class="row-action danger" data-delete-product="${escapeHtml(product.id)}" aria-label="Hapus ${escapeHtml(product.name)}" title="Hapus produk">×</button></span></td>
    </tr>`;
  }).join('');
  if (state.products.length && !filtered.length) {
    byId('products-table').innerHTML = '<tr><td colspan="6" class="table-no-results">Tidak ada produk yang cocok dengan pencarian.</td></tr>';
  }
}

function renderMovements() {
  const rows = byId('movements-table');
  byId('movement-results').textContent = `${state.movements.length} aktivitas`;
  byId('movements-empty').classList.toggle('visible', state.movements.length === 0);
  rows.closest('.table-scroll').style.display = state.movements.length ? '' : 'none';
  rows.innerHTML = state.movements.map((item) => {
    const isLatest = state.movements.find((candidate) => candidate.product_id === item.product_id)?.id === item.id;
    const disabled = isLatest ? '' : 'disabled';
    const actionHint = isLatest ? 'Edit atau hapus mutasi' : 'Hanya mutasi terbaru produk yang dapat diubah';
    return `<tr>
    <td>${escapeHtml(formatDate(item.created_at))}</td><td>${escapeHtml(movementProduct(item))}</td>
    <td><span class="type-pill ${movementClass(item.movement_type)}">${movementLabel(item.movement_type)}</span></td>
    <td>${number.format(item.quantity)} ${escapeHtml(item.product?.unit || state.products.find((product) => product.id === item.product_id)?.unit || 'unit')}</td>
    <td>${number.format(item.stock_after)}</td><td>${escapeHtml(item.note || '—')}</td>
    <td><span class="row-actions"><button class="row-action" data-edit-movement="${escapeHtml(item.id)}" aria-label="Edit mutasi" title="${actionHint}" ${disabled}>✎</button><button class="row-action danger" data-delete-movement="${escapeHtml(item.id)}" aria-label="Hapus mutasi" title="${actionHint}" ${disabled}>×</button></span></td>
  </tr>`;
  }).join('');
}

function renderMasters() {
  byId('category-total').textContent = number.format(state.categories.length);
  byId('supplier-total').textContent = number.format(state.suppliers.length);
  byId('categories-list').innerHTML = state.categories.length
    ? state.categories.map((item) => `<div class="master-item"><span>${escapeHtml(item.name)}<small>${state.products.filter((product) => getCategoryName(product) === item.name).length} produk</small></span><span class="row-actions"><button class="row-action" data-edit-master="categories" data-master-id="${escapeHtml(item.id)}" aria-label="Edit kategori ${escapeHtml(item.name)}" title="Edit kategori">✎</button><button class="row-action danger" data-delete-master="categories" data-master-id="${escapeHtml(item.id)}" aria-label="Hapus kategori ${escapeHtml(item.name)}" title="Hapus kategori">×</button></span></div>`).join('')
    : '<div class="master-empty">Kategori akan muncul di sini.</div>';
  byId('suppliers-list').innerHTML = state.suppliers.length
    ? state.suppliers.map((item) => `<div class="master-item"><span>${escapeHtml(item.name)}<small>${state.products.filter((product) => getSupplierName(product) === item.name).length} produk</small></span><span class="row-actions"><button class="row-action" data-edit-master="suppliers" data-master-id="${escapeHtml(item.id)}" aria-label="Edit pemasok ${escapeHtml(item.name)}" title="Edit pemasok">✎</button><button class="row-action danger" data-delete-master="suppliers" data-master-id="${escapeHtml(item.id)}" aria-label="Hapus pemasok ${escapeHtml(item.name)}" title="Hapus pemasok">×</button></span></div>`).join('')
    : '<div class="master-empty">Pemasok akan muncul di sini.</div>';
  byId('category-options').innerHTML = state.categories.map((item) => `<option value="${escapeHtml(item.name)}"></option>`).join('');
  byId('supplier-options').innerHTML = state.suppliers.map((item) => `<option value="${escapeHtml(item.name)}"></option>`).join('');
}

function updateProductOptions() {
  const select = byId('movement-form').elements.product_id;
  const selected = select.value;
  select.innerHTML = '<option value="">Pilih produk</option>' + state.products.map((product) => `<option value="${escapeHtml(product.id)}">${escapeHtml(product.name)} · stok ${number.format(product.current_stock)}</option>`).join('');
  if (state.products.some((product) => product.id === selected)) select.value = selected;
}

function setView(view) {
  state.view = view;
  document.querySelectorAll('.view').forEach((section) => section.classList.toggle('active', section.id === `view-${view}`));
  document.querySelectorAll('.nav-link').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  const labels = { dashboard: 'Ringkasan', products: 'Produk', movements: 'Mutasi stok', masters: 'Data master' };
  byId('breadcrumb-title').textContent = labels[view];
  byId('sidebar').classList.remove('open');
}

let toastTimer;
function showToast(message, error = false) {
  const toast = byId('toast');
  toast.textContent = message;
  toast.classList.toggle('error', error);
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
}

function openProductEditor(id) {
  const product = state.products.find((item) => item.id === id);
  if (!product) return;
  const form = byId('product-form');
  form.reset();
  form.dataset.editId = id;
  form.elements.sku.value = product.sku;
  form.elements.name.value = product.name;
  form.elements.category_name.value = getCategoryName(product);
  form.elements.supplier_name.value = getSupplierName(product);
  form.elements.unit.value = product.unit || 'pcs';
  form.elements.initial_stock.value = product.current_stock;
  form.elements.min_stock.value = product.min_stock;
  form.elements.cost_price.value = product.cost_price;
  form.elements.selling_price.value = product.selling_price;
  byId('initial-stock-field').hidden = true;
  byId('product-dialog-title').textContent = 'Edit produk';
  byId('product-submit').textContent = 'Simpan perubahan';
  byId('product-dialog').showModal();
}

function openMovementEditor(id) {
  const movement = state.movements.find((item) => item.id === id);
  if (!movement) return;
  const form = byId('movement-form');
  form.reset();
  form.dataset.editId = id;
  form.elements.product_id.value = movement.product_id;
  form.elements.product_id.disabled = true;
  form.elements.movement_type.value = movement.movement_type;
  form.elements.quantity.value = movement.quantity;
  form.elements.note.value = movement.note || '';
  const isAdjust = movement.movement_type === 'ADJUST';
  form.elements.quantity.min = isAdjust ? '0' : '1';
  byId('movement-quantity-label').firstChild.textContent = isAdjust ? 'Jumlah stok sebenarnya *' : 'Jumlah unit *';
  byId('movement-help').textContent = isAdjust ? 'Isi jumlah stok yang tersedia setelah penghitungan.' : 'Jumlah unit yang masuk atau keluar.';
  byId('movement-dialog-title').textContent = 'Edit mutasi terbaru';
  byId('movement-submit').textContent = 'Simpan perubahan';
  byId('movement-dialog').showModal();
}

function openMasterDialog(table, id = '') {
  const form = byId('master-form');
  const item = (table === 'categories' ? state.categories : state.suppliers).find((entry) => entry.id === id);
  form.reset();
  form.dataset.table = table;
  form.dataset.editId = id;
  byId('supplier-fields').hidden = table !== 'suppliers';
  byId('master-dialog-title').textContent = `${id ? 'Edit' : 'Tambah'} ${table === 'categories' ? 'kategori' : 'pemasok'}`;
  byId('master-submit').textContent = id ? 'Simpan perubahan' : 'Simpan';
  if (item) {
    form.elements.name.value = item.name;
    if (table === 'suppliers') {
      form.elements.phone.value = item.phone || '';
      form.elements.email.value = item.email || '';
    }
  }
  byId('master-dialog').showModal();
}

function openDialog(id) {
  if (id === 'movement-dialog' && !state.products.length) {
    showToast('Tambahkan produk sebelum mencatat mutasi.', true);
    return;
  }
  if (id === 'product-dialog') {
    const form = byId('product-form');
    form.reset();
    delete form.dataset.editId;
    byId('initial-stock-field').hidden = false;
    byId('product-dialog-title').textContent = 'Tambah produk';
    byId('product-submit').textContent = 'Simpan produk';
  }
  if (id === 'movement-dialog') {
    const form = byId('movement-form');
    form.reset();
    delete form.dataset.editId;
    form.elements.product_id.disabled = false;
    form.elements.movement_type.value = 'IN';
    form.elements.quantity.min = '1';
    byId('movement-quantity-label').firstChild.textContent = 'Jumlah unit *';
    byId('movement-help').textContent = 'Jumlah unit yang masuk atau keluar.';
    byId('movement-dialog-title').textContent = 'Catat mutasi';
    byId('movement-submit').textContent = 'Simpan mutasi';
  }
  byId(id).showModal();
}

function closeDialog(dialog) {
  dialog.close();
}

async function addProduct(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const editId = form.dataset.editId || '';
  const values = Object.fromEntries(new FormData(form));
  const product = {
    sku: values.sku.trim().toUpperCase(),
    name: values.name.trim(),
    category_name: values.category_name.trim(),
    supplier_name: values.supplier_name.trim(),
    unit: values.unit.trim(),
    initial_stock: Number(values.initial_stock),
    min_stock: Number(values.min_stock),
    cost_price: Number(values.cost_price),
    selling_price: Number(values.selling_price),
  };
  if (state.products.some((item) => item.id !== editId && item.sku.toLocaleUpperCase('id') === product.sku)) {
    showToast('SKU sudah digunakan produk lain.', true);
    return;
  }
  try {
    if (state.remote) {
      const path = editId ? `/api/products/${encodeURIComponent(editId)}` : '/api/products';
      await request(path, { method: editId ? 'PATCH' : 'POST', body: JSON.stringify(product) });
      await loadData();
    } else if (editId) {
      const existing = state.products.find((item) => item.id === editId);
      if (!existing) throw new Error('Produk tidak ditemukan.');
      const { initial_stock, ...metadata } = product;
      Object.assign(existing, metadata);
      ensureLocalMaster('categories', product.category_name);
      ensureLocalMaster('suppliers', product.supplier_name);
      saveLocal();
      render();
    } else {
      const now = new Date().toISOString();
      const savedProduct = { ...product, id: crypto.randomUUID(), current_stock: product.initial_stock, created_at: now };
      state.products.push(savedProduct);
      ensureLocalMaster('categories', product.category_name);
      ensureLocalMaster('suppliers', product.supplier_name);
      if (product.initial_stock > 0) {
        state.movements.unshift({ id: crypto.randomUUID(), product_id: savedProduct.id, product: savedProduct, movement_type: 'IN', quantity: product.initial_stock, stock_before: 0, stock_after: product.initial_stock, note: 'Stok awal', created_at: now });
      }
      saveLocal();
      render();
    }
    closeDialog(byId('product-dialog'));
    form.reset();
    delete form.dataset.editId;
    byId('initial-stock-field').hidden = false;
    byId('product-dialog-title').textContent = 'Tambah produk';
    byId('product-submit').textContent = 'Simpan produk';
    form.elements.unit.value = 'pcs';
    form.elements.min_stock.value = '5';
    showToast(editId ? 'Perubahan produk disimpan.' : 'Produk berhasil disimpan.');
  } catch (error) {
    showToast(error.message, true);
  }
}

async function addMovement(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const editId = form.dataset.editId || '';
  const editedMovement = editId ? state.movements.find((item) => item.id === editId) : null;
  const values = Object.fromEntries(new FormData(form));
  const input = {
    product_id: editedMovement?.product_id || values.product_id,
    movement_type: values.movement_type,
    quantity: Number(values.quantity),
    note: values.note.trim(),
  };
  const product = state.products.find((item) => item.id === input.product_id);
  if (!product) return showToast('Pilih produk yang tersedia.', true);
  const availableStock = editedMovement ? Number(editedMovement.stock_before) : Number(product.current_stock);
  if (input.movement_type === 'OUT' && input.quantity > availableStock) {
    return showToast(`Stok tidak mencukupi. Tersedia ${availableStock} ${product.unit}.`, true);
  }
  if (!input.quantity && input.movement_type !== 'ADJUST') return showToast('Jumlah harus lebih dari nol.', true);
  try {
    if (state.remote) {
      const path = editId ? `/api/movements/${encodeURIComponent(editId)}` : '/api/movements';
      await request(path, { method: editId ? 'PATCH' : 'POST', body: JSON.stringify(input) });
      await loadData();
    } else if (editedMovement) {
      const latest = state.movements.find((item) => item.product_id === input.product_id);
      if (latest?.id !== editId || Number(product.current_stock) !== Number(editedMovement.stock_after)) {
        throw new Error('Hanya mutasi terbaru yang bisa diedit. Muat ulang data.');
      }
      const before = Number(editedMovement.stock_before);
      const after = input.movement_type === 'IN' ? before + input.quantity : input.movement_type === 'OUT' ? before - input.quantity : input.quantity;
      if (after < 0) throw new Error('Stok tidak mencukupi untuk perubahan ini.');
      product.current_stock = after;
      Object.assign(editedMovement, input, { product, stock_before: before, stock_after: after });
      saveLocal();
      render();
    } else {
      const before = Number(product.current_stock);
      const after = input.movement_type === 'IN' ? before + input.quantity : input.movement_type === 'OUT' ? before - input.quantity : input.quantity;
      product.current_stock = after;
      const movement = { ...input, id: crypto.randomUUID(), product, stock_before: before, stock_after: after, created_at: new Date().toISOString() };
      state.movements.unshift(movement);
      saveLocal();
      render();
    }
    closeDialog(byId('movement-dialog'));
    form.reset();
    delete form.dataset.editId;
    form.elements.product_id.disabled = false;
    byId('movement-dialog-title').textContent = 'Catat mutasi';
    byId('movement-submit').textContent = 'Simpan mutasi';
    byId('movement-quantity-label').firstChild.textContent = 'Jumlah unit *';
    byId('movement-quantity-label').querySelector('input').min = '1';
    byId('movement-help').textContent = 'Jumlah unit yang masuk atau keluar.';
    showToast(editId ? 'Perubahan mutasi disimpan.' : 'Mutasi stok berhasil dicatat.');
  } catch (error) {
    showToast(error.message, true);
  }
}

async function deleteMovement(id) {
  const movement = state.movements.find((item) => item.id === id);
  if (!movement || !window.confirm('Hapus mutasi terbaru dan kembalikan saldo stok sebelumnya?')) return;
  const latest = state.movements.find((item) => item.product_id === movement.product_id);
  if (latest?.id !== id) return showToast('Hanya mutasi terbaru produk yang dapat dihapus.', true);
  const product = state.products.find((item) => item.id === movement.product_id);
  if (!product) return showToast('Produk terkait tidak ditemukan.', true);
  try {
    if (state.remote) {
      await request(`/api/movements/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await loadData();
    } else {
      if (Number(product.current_stock) !== Number(movement.stock_after)) {
        throw new Error('Saldo stok sudah berubah. Muat ulang data.');
      }
      product.current_stock = Number(movement.stock_before);
      state.movements = state.movements.filter((item) => item.id !== id);
      saveLocal();
      render();
    }
    showToast('Mutasi dihapus dan saldo stok dikembalikan.');
  } catch (error) {
    showToast(error.message, true);
  }
}

async function saveMaster(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const table = form.dataset.table;
  const editId = form.dataset.editId || '';
  const oldItem = (table === 'categories' ? state.categories : state.suppliers).find((item) => item.id === editId);
  const values = Object.fromEntries(new FormData(form));
  const payload = table === 'categories'
    ? { name: values.name.trim() }
    : { name: values.name.trim(), phone: values.phone.trim() || null, email: values.email.trim() || null };
  const list = table === 'categories' ? state.categories : state.suppliers;
  if (list.some((item) => item.id !== editId && item.name.toLocaleLowerCase('id') === payload.name.toLocaleLowerCase('id'))) {
    return showToast('Nama data master sudah digunakan.', true);
  }

  try {
    if (state.remote) {
      const path = editId ? `/api/${table}/${encodeURIComponent(editId)}` : `/api/${table}`;
      await request(path, { method: editId ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
      await loadData();
    } else if (editId && oldItem) {
      const oldName = oldItem.name;
      oldItem.name = payload.name;
      if (table === 'suppliers') Object.assign(oldItem, { phone: payload.phone, email: payload.email });
      const getName = table === 'categories' ? getCategoryName : getSupplierName;
      const field = table === 'categories' ? 'category_name' : 'supplier_name';
      state.products.forEach((product) => {
        if (getName(product) !== oldName) return;
        if (product[field] !== undefined) product[field] = payload.name;
        if (table === 'categories' && product.category) product.category = { ...product.category, name: payload.name };
        if (table === 'suppliers' && product.supplier) product.supplier = { ...product.supplier, name: payload.name };
      });
      saveLocal();
      render();
    } else {
      list.push({ id: crypto.randomUUID(), ...payload });
      saveLocal();
      render();
    }
    byId('master-dialog').close();
    form.reset();
    delete form.dataset.table;
    delete form.dataset.editId;
    showToast(editId ? 'Perubahan data master disimpan.' : 'Data master ditambahkan.');
  } catch (error) {
    showToast(error.message, true);
  }
}

async function deleteMaster(table, id) {
  const list = table === 'categories' ? state.categories : state.suppliers;
  const item = list.find((entry) => entry.id === id);
  if (!item || !window.confirm(`Hapus ${table === 'categories' ? 'kategori' : 'pemasok'} "${item.name}"?`)) return;
  try {
    if (state.remote) {
      await request(`/api/${table}/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await loadData();
    } else {
      const getName = table === 'categories' ? getCategoryName : getSupplierName;
      const field = table === 'categories' ? 'category_name' : 'supplier_name';
      state.products.forEach((product) => {
        if (getName(product) === item.name) {
          if (product[field] !== undefined) product[field] = '';
          if (table === 'categories') product.category = null;
          else product.supplier = null;
        }
      });
      const remaining = list.filter((entry) => entry.id !== id);
      if (table === 'categories') state.categories = remaining;
      else state.suppliers = remaining;
      saveLocal();
      render();
    }
    showToast('Data master dihapus. Produk terkait tetap tersimpan.');
  } catch (error) {
    showToast(error.message, true);
  }
}

async function deleteProduct(id) {
  const product = state.products.find((item) => item.id === id);
  if (!product || !window.confirm(`Hapus produk "${product.name}"? Seluruh riwayat mutasi stok produk ini juga akan dihapus.`)) return;
  try {
    if (state.remote) {
      await request(`/api/products/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await loadData();
    } else {
      state.products = state.products.filter((item) => item.id !== id);
      state.movements = state.movements.filter((item) => item.product_id !== id);
      saveLocal();
      render();
    }
    showToast('Produk berhasil dihapus.');
  } catch (error) {
    showToast(error.message, true);
  }
}

document.addEventListener('click', (event) => {
  const viewButton = event.target.closest('[data-view]');
  if (viewButton) return setView(viewButton.dataset.view);
  const openButton = event.target.closest('[data-open]');
  if (openButton) return openDialog(openButton.dataset.open);
  const closeButton = event.target.closest('[data-close]');
  if (closeButton) return closeDialog(closeButton.closest('dialog'));
  const deleteButton = event.target.closest('[data-delete-product]');
  if (deleteButton) deleteProduct(deleteButton.dataset.deleteProduct);
  const editProductButton = event.target.closest('[data-edit-product]');
  if (editProductButton) openProductEditor(editProductButton.dataset.editProduct);
  const editMovementButton = event.target.closest('[data-edit-movement]');
  if (editMovementButton && !editMovementButton.disabled) openMovementEditor(editMovementButton.dataset.editMovement);
  const deleteMovementButton = event.target.closest('[data-delete-movement]');
  if (deleteMovementButton && !deleteMovementButton.disabled) deleteMovement(deleteMovementButton.dataset.deleteMovement);
  const addMasterButton = event.target.closest('[data-add-master]');
  if (addMasterButton) openMasterDialog(addMasterButton.dataset.addMaster);
  const editMasterButton = event.target.closest('[data-edit-master]');
  if (editMasterButton) openMasterDialog(editMasterButton.dataset.editMaster, editMasterButton.dataset.masterId);
  const deleteMasterButton = event.target.closest('[data-delete-master]');
  if (deleteMasterButton) deleteMaster(deleteMasterButton.dataset.deleteMaster, deleteMasterButton.dataset.masterId);
});

document.querySelectorAll('dialog').forEach((dialog) => {
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
});
byId('product-search').addEventListener('input', renderProducts);
byId('product-form').addEventListener('submit', addProduct);
byId('movement-form').addEventListener('submit', addMovement);
byId('master-form').addEventListener('submit', saveMaster);
byId('movement-form').elements.movement_type.addEventListener('change', (event) => {
  const isAdjust = event.target.value === 'ADJUST';
  const quantity = byId('movement-quantity-label').querySelector('input');
  quantity.min = isAdjust ? '0' : '1';
  byId('movement-quantity-label').firstChild.textContent = isAdjust ? 'Jumlah stok sebenarnya *' : 'Jumlah unit *';
  byId('movement-help').textContent = isAdjust ? 'Isi jumlah stok yang tersedia setelah penghitungan.' : 'Jumlah unit yang masuk atau keluar.';
});
byId('mobile-menu').addEventListener('click', () => byId('sidebar').classList.toggle('open'));
byId('login-form').addEventListener('submit', signIn);
byId('year').textContent = new Date().getFullYear();
byId('logout-button').addEventListener('click', signOut);
initializeAuth();
