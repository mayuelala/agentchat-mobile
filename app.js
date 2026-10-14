'use strict';

const APP_VERSION = '1.2.0';
const SETTINGS_KEY = 'agentchat.settings.v1';
const LEGACY_MESSAGES_KEY = 'agentchat.messages.v1';
const CONVERSATIONS_KEY = 'agentchat.conversations.v2';
const ACTIVE_CONVERSATION_KEY = 'agentchat.activeConversation.v2';
const ATTACHMENT_DB_NAME = 'agentchat-attachments-v1';
const ATTACHMENT_STORE = 'attachments';
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 16 * 1024 * 1024;

const defaultSettings = {
  baseURL: 'https://modelservice.jdcloud.com/v1',
  model: 'gpt-5.6-sol',
  effort: 'high',
  apiKey: ''
};

const roleAgents = [
  { id: 'researcher', kind: 'role', name: '研究员', mention: '@研究员', aliases: ['@researcher', '@research', '@研究'], icon: '⌕', instructions: '你是研究型子 Agent。先拆解问题，辨别事实、假设与不确定性，再给出有依据、可核查的结论。不要虚构来源。' },
  { id: 'coder', kind: 'role', name: '工程师', mention: '@工程师', aliases: ['@coder', '@code', '@代码'], icon: '⌘', instructions: '你是工程型子 Agent。给出可落地、结构清晰的技术方案，主动检查边界条件、安全性与测试方式。' },
  { id: 'reviewer', kind: 'role', name: '审阅者', mention: '@审阅者', aliases: ['@reviewer', '@review', '@审阅'], icon: '✓', instructions: '你是严格的审阅子 Agent。寻找遗漏、矛盾、风险与不成立的假设，并提出具体修正建议。' },
  { id: 'writer', kind: 'role', name: '写作者', mention: '@写作者', aliases: ['@writer', '@write', '@写作'], icon: '✎', instructions: '你是写作型子 Agent。把信息组织成自然、准确、易读的中文；保持用户语气，不堆砌格式。' }
];

const coordinatorInstructions = '你是 AgentChat 的主 Agent。用用户使用的语言回答，先给结论，再给必要细节。保持诚实、清晰和可执行；不知道就说明不确定性。不要声称拥有手机或电脑上并未提供的工具权限。';
const welcome = '你好，我是 AgentChat。你可以直接聊天、上传图片或文件，也可以 @预设Agent 或 @其他对话，让它们带着各自上下文协作。';

const $ = id => document.getElementById(id);
const els = {
  messages: $('messages'),
  prompt: $('prompt'),
  send: $('send'),
  attach: $('attach'),
  agents: $('agents'),
  mentionMenu: $('mention-menu'),
  pendingAttachments: $('pending-attachments'),
  status: $('status'),
  statusText: $('status-text'),
  error: $('error'),
  settingsOverlay: $('settings-overlay'),
  attachmentOverlay: $('attachment-overlay'),
  baseURL: $('base-url'),
  model: $('model'),
  apiKey: $('api-key'),
  effort: $('effort'),
  installTip: $('install-tip'),
  historySidebar: $('history-sidebar'),
  historyBackdrop: $('history-backdrop'),
  historyList: $('history-list'),
  cameraInput: $('camera-input'),
  photoInput: $('photo-input'),
  fileInput: $('file-input')
};

let settings = loadObject(SETTINGS_KEY, defaultSettings);
let conversations = loadArray(CONVERSATIONS_KEY);
let activeConversationId = localStorage.getItem(ACTIVE_CONVERSATION_KEY) || '';
let messages = [];
let pendingAttachments = [];
let controller = null;
let busy = false;

migrateAndInitialize();

function makeId(prefix = 'id') {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function newWelcomeMessage() {
  return { role: 'assistant', content: welcome, author: 'AgentChat', local: true, time: Date.now() };
}

function createConversation(initialMessages = [newWelcomeMessage()]) {
  const now = Date.now();
  return {
    id: makeId('chat'),
    title: uniqueConversationTitle('新对话'),
    createdAt: now,
    updatedAt: now,
    messages: initialMessages
  };
}

function migrateAndInitialize() {
  if (!Array.isArray(conversations) || conversations.length === 0) {
    const legacy = loadArray(LEGACY_MESSAGES_KEY);
    const initial = legacy.length ? legacy : [newWelcomeMessage()];
    conversations = [createConversation(initial)];
  }
  conversations = conversations.filter(item => item && item.id && Array.isArray(item.messages));
  if (!conversations.length) conversations = [createConversation()];
  if (!conversations.some(item => item.id === activeConversationId)) {
    activeConversationId = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)[0].id;
  }
  messages = activeConversation().messages;
  saveState();
}

function loadObject(key, fallback) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '{}');
    return parsed && !Array.isArray(parsed) ? { ...fallback, ...parsed } : { ...fallback };
  } catch { return { ...fallback }; }
}

function loadArray(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function compactAttachment(attachment) {
  return {
    id: attachment.id,
    name: attachment.name,
    type: attachment.type,
    size: attachment.size,
    kind: attachment.kind
  };
}

function openAttachmentDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ATTACHMENT_DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(ATTACHMENT_STORE)) {
        request.result.createObjectStore(ATTACHMENT_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('附件数据库无法打开'));
  });
}

async function storeAttachmentData(attachment) {
  if (!attachment.dataURL) return;
  try {
    const database = await openAttachmentDB();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(ATTACHMENT_STORE, 'readwrite');
      transaction.objectStore(ATTACHMENT_STORE).put({ id: attachment.id, dataURL: attachment.dataURL });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  } catch (error) {
    console.warn('附件持久化失败', error);
  }
}

async function hydrateAttachments(messageList) {
  const missing = messageList.flatMap(message => message.attachments || []).filter(item => !item.dataURL);
  if (!missing.length) return;
  try {
    const database = await openAttachmentDB();
    await Promise.all(missing.map(attachment => new Promise(resolve => {
      const transaction = database.transaction(ATTACHMENT_STORE, 'readonly');
      const request = transaction.objectStore(ATTACHMENT_STORE).get(attachment.id);
      request.onsuccess = () => {
        if (request.result?.dataURL) attachment.dataURL = request.result.dataURL;
        resolve();
      };
      request.onerror = () => resolve();
    })));
    database.close();
  } catch (error) {
    console.warn('附件恢复失败', error);
  }
}

async function deleteAttachmentData(ids) {
  if (!ids.length) return;
  try {
    const database = await openAttachmentDB();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(ATTACHMENT_STORE, 'readwrite');
      ids.forEach(id => transaction.objectStore(ATTACHMENT_STORE).delete(id));
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  } catch (error) {
    console.warn('附件清理失败', error);
  }
}

function saveState() {
  const persistable = conversations.slice(0, 60).map(conversation => ({
    ...conversation,
    messages: conversation.messages.slice(-200).map(message => ({
      ...message,
      attachments: (message.attachments || []).map(compactAttachment)
    }))
  }));
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(persistable));
  localStorage.setItem(ACTIVE_CONVERSATION_KEY, activeConversationId);
}

function activeConversation() {
  return conversations.find(item => item.id === activeConversationId) || conversations[0];
}

function uniqueConversationTitle(base, exceptId = '') {
  const clean = (base || '新对话').replace(/[「」]/g, '').trim().slice(0, 28) || '新对话';
  const used = new Set(conversations.filter(item => item.id !== exceptId).map(item => item.title));
  if (!used.has(clean)) return clean;
  let index = 2;
  while (used.has(`${clean} ${index}`)) index += 1;
  return `${clean} ${index}`;
}

function titleFromPrompt(prompt, attachments = []) {
  const withoutMentions = prompt
    .replace(/@「[^」]+」/g, '')
    .replace(/@(研究员|工程师|审阅者|写作者|researcher|research|coder|code|reviewer|review|writer|write|研究|代码|审阅|写作)/gi, '')
    .trim();
  if (withoutMentions) return withoutMentions.replace(/\s+/g, ' ').slice(0, 28);
  return attachments[0]?.name?.slice(0, 28) || '附件对话';
}

function keyLooksComplete(value) {
  return value.startsWith('pk-') && value.length >= 20 && !value.includes('…') && !value.includes('...');
}

function importKeyFromFragment() {
  try {
    const params = new URLSearchParams(location.hash.slice(1));
    const imported = (params.get('api_key') || '').trim();
    if (!keyLooksComplete(imported)) return false;
    settings.apiKey = imported;
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    saveState();
    return true;
  } catch { return false; }
}

function conversationMention(conversation) {
  return `@「${conversation.title.replace(/[「」]/g, '')}」`;
}

function switchConversation(id) {
  if (busy) controller?.abort();
  const target = conversations.find(item => item.id === id);
  if (!target) return;
  activeConversationId = id;
  messages = target.messages;
  pendingAttachments = [];
  saveState();
  renderMessages();
  hydrateAttachments(messages).then(renderMessages);
  renderPendingAttachments();
  renderHistory();
  closeHistory();
  showError();
  syncSend();
}

function startNewChat() {
  if (busy) controller?.abort();
  const current = activeConversation();
  const hasUserMessage = current.messages.some(item => item.role === 'user');
  if (!hasUserMessage) {
    current.messages = [newWelcomeMessage()];
    current.title = uniqueConversationTitle('新对话', current.id);
    current.updatedAt = Date.now();
    messages = current.messages;
  } else {
    const conversation = createConversation();
    conversations.unshift(conversation);
    activeConversationId = conversation.id;
    messages = conversation.messages;
  }
  pendingAttachments = [];
  saveState();
  renderAll();
  closeHistory();
  showError();
}

function deleteConversation(id) {
  const target = conversations.find(item => item.id === id);
  if (!target || !confirm(`删除对话“${target.title}”？`)) return;
  const attachmentIds = target.messages.flatMap(message => message.attachments || []).map(item => item.id);
  deleteAttachmentData(attachmentIds);
  conversations = conversations.filter(item => item.id !== id);
  if (!conversations.length) conversations = [createConversation()];
  if (activeConversationId === id) {
    activeConversationId = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)[0].id;
    messages = activeConversation().messages;
  }
  saveState();
  renderAll();
}

function openHistory() {
  renderHistory();
  els.historySidebar.classList.add('visible');
  els.historyBackdrop.classList.add('visible');
}

function closeHistory() {
  els.historySidebar.classList.remove('visible');
  els.historyBackdrop.classList.remove('visible');
}

function relativeTime(timestamp) {
  const diff = Date.now() - Number(timestamp || 0);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`;
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function renderHistory() {
  els.historyList.replaceChildren();
  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  sorted.forEach(conversation => {
    const row = document.createElement('div');
    row.className = 'history-row';

    const item = document.createElement('button');
    item.className = `history-item${conversation.id === activeConversationId ? ' active' : ''}`;
    const title = document.createElement('strong'); title.textContent = conversation.title;
    const time = document.createElement('small'); time.textContent = relativeTime(conversation.updatedAt);
    item.append(title, time);
    item.addEventListener('click', () => switchConversation(conversation.id));

    const mention = document.createElement('button');
    mention.className = 'history-delete'; mention.textContent = '@'; mention.title = '在当前对话中提及';
    mention.disabled = conversation.id === activeConversationId;
    mention.addEventListener('click', event => {
      event.stopPropagation();
      insertMention(conversationMention(conversation));
      closeHistory();
    });

    const remove = document.createElement('button');
    remove.className = 'history-delete'; remove.textContent = '×'; remove.title = '删除';
    remove.addEventListener('click', event => { event.stopPropagation(); deleteConversation(conversation.id); });

    row.style.gridTemplateColumns = '1fr 32px 32px';
    row.append(item, mention, remove);
    els.historyList.appendChild(row);
  });
}

function renderMessages() {
  els.messages.replaceChildren();
  messages.forEach(message => {
    const row = document.createElement('article');
    row.className = `message ${message.role}`;
    if (message.role === 'assistant') {
      const avatar = document.createElement('div');
      avatar.className = 'avatar'; avatar.textContent = '✦';
      row.appendChild(avatar);
    }

    const content = document.createElement('div'); content.className = 'content';
    if (message.author) {
      const author = document.createElement('div'); author.className = 'author'; author.textContent = message.author;
      content.appendChild(author);
    }
    const bubble = document.createElement('div'); bubble.className = 'bubble'; bubble.textContent = message.content;
    content.appendChild(bubble);

    if (message.attachments?.length) {
      const attachments = document.createElement('div'); attachments.className = 'message-attachments';
      message.attachments.forEach(attachment => {
        const chip = document.createElement('div'); chip.className = 'message-attachment';
        if (attachment.kind === 'image' && attachment.dataURL) {
          const image = document.createElement('img'); image.src = attachment.dataURL; image.alt = attachment.name;
          chip.appendChild(image);
        } else {
          const icon = document.createElement('b'); icon.textContent = attachment.kind === 'image' ? '🖼️' : '📄';
          const name = document.createElement('span'); name.textContent = attachment.name;
          chip.append(icon, name);
        }
        attachments.appendChild(chip);
      });
      content.appendChild(attachments);
    }
    row.appendChild(content);
    els.messages.appendChild(row);
  });
  requestAnimationFrame(() => { els.messages.scrollTop = els.messages.scrollHeight; });
}

function renderRoleAgents() {
  els.agents.replaceChildren();
  roleAgents.forEach(agent => {
    const button = document.createElement('button'); button.className = 'agent';
    button.textContent = `${agent.icon} ${agent.name}`;
    button.addEventListener('click', () => insertMention(agent.mention));
    els.agents.appendChild(button);
  });
}

function mentionCandidates() {
  const roleCandidates = roleAgents.map(agent => ({
    label: agent.name,
    detail: '预设 Agent',
    mention: agent.mention,
    icon: agent.icon
  }));
  const conversationCandidates = conversations
    .filter(item => item.id !== activeConversationId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(conversation => ({
      label: conversation.title,
      detail: '历史对话',
      mention: conversationMention(conversation),
      icon: '💬'
    }));
  return [...roleCandidates, ...conversationCandidates];
}

function currentMentionQuery() {
  const value = els.prompt.value;
  const at = value.lastIndexOf('@');
  if (at < 0) return null;
  const before = value.slice(0, at);
  if (before && !/[\s\n]$/.test(before)) return null;
  const fragment = value.slice(at + 1);
  if (fragment.includes('\n') || fragment.includes('」') || fragment.includes(' ')) return null;
  return { at, query: fragment.replace(/[「」]/g, '').toLocaleLowerCase() };
}

function renderMentionMenu() {
  const mentionQuery = currentMentionQuery();
  els.mentionMenu.replaceChildren();
  if (!mentionQuery) {
    els.mentionMenu.classList.remove('visible');
    return;
  }
  const candidates = mentionCandidates().filter(item =>
    !mentionQuery.query || `${item.label} ${item.detail}`.toLocaleLowerCase().includes(mentionQuery.query)
  );
  candidates.slice(0, 12).forEach(candidate => {
    const button = document.createElement('button'); button.className = 'mention-option';
    const icon = document.createElement('b'); icon.textContent = candidate.icon;
    const copy = document.createElement('span');
    const name = document.createElement('strong'); name.textContent = candidate.label;
    const detail = document.createElement('small'); detail.textContent = candidate.detail;
    copy.append(name, detail); button.append(icon, copy);
    button.addEventListener('click', () => insertMention(candidate.mention));
    els.mentionMenu.appendChild(button);
  });
  els.mentionMenu.classList.toggle('visible', candidates.length > 0);
}

function insertMention(mention) {
  const value = els.prompt.value;
  const query = currentMentionQuery();
  if (query) {
    els.prompt.value = `${value.slice(0, query.at)}${mention} `;
  } else {
    if (value && !value.endsWith(' ')) els.prompt.value += ' ';
    els.prompt.value += `${mention} `;
  }
  resizePrompt();
  renderMentionMenu();
  syncSend();
  els.prompt.focus();
}

function renderPendingAttachments() {
  els.pendingAttachments.replaceChildren();
  pendingAttachments.forEach(attachment => {
    const item = document.createElement('div'); item.className = 'pending-item';
    if (attachment.kind === 'image') {
      const image = document.createElement('img'); image.src = attachment.dataURL; image.alt = attachment.name;
      item.appendChild(image);
    } else {
      const file = document.createElement('div'); file.className = 'pending-file';
      const icon = document.createElement('b'); icon.textContent = '📄';
      const name = document.createElement('span'); name.textContent = attachment.name;
      file.append(icon, name); item.appendChild(file);
    }
    const remove = document.createElement('button');
    remove.className = 'remove-attachment'; remove.textContent = '×'; remove.ariaLabel = `移除 ${attachment.name}`;
    remove.addEventListener('click', () => {
      pendingAttachments = pendingAttachments.filter(entry => entry.id !== attachment.id);
      renderPendingAttachments(); syncSend();
    });
    item.appendChild(remove); els.pendingAttachments.appendChild(item);
  });
  els.pendingAttachments.classList.toggle('visible', pendingAttachments.length > 0);
}

function resizePrompt() {
  els.prompt.style.height = 'auto';
  els.prompt.style.height = `${Math.min(142, els.prompt.scrollHeight)}px`;
}

function syncSend() {
  const hasInput = Boolean(els.prompt.value.trim() || pendingAttachments.length);
  els.send.disabled = !busy && !hasInput;
  els.send.textContent = busy ? '■' : '↑';
  els.send.setAttribute('aria-label', busy ? '停止' : '发送');
  els.send.style.background = busy ? '#d43737' : '';
}

function showStatus(text = '') {
  els.statusText.textContent = text;
  els.status.classList.toggle('visible', Boolean(text));
}

function showError(text = '') {
  els.error.textContent = text;
  els.error.style.display = text ? 'block' : 'none';
}

function openSettings() {
  els.baseURL.value = settings.baseURL;
  els.model.value = settings.model;
  els.apiKey.value = settings.apiKey;
  els.effort.value = settings.effort;
  els.settingsOverlay.classList.add('visible');
}

function saveSettings() {
  const next = {
    baseURL: els.baseURL.value.trim().replace(/\/+$/, ''),
    model: els.model.value.trim(),
    apiKey: els.apiKey.value.trim(),
    effort: els.effort.value
  };
  if (!next.baseURL.startsWith('https://')) return alert('Base URL 必须使用 HTTPS');
  if (!next.model || !next.apiKey) return alert('模型和 API Key 不能为空');
  if (!keyLooksComplete(next.apiKey)) return alert('API Key 不完整。请粘贴完整 Key，而不是脱敏值。');
  settings = next;
  saveState();
  showError();
  els.settingsOverlay.classList.remove('visible');
}

function openAttachmentSheet() {
  if (busy) return;
  els.attachmentOverlay.classList.add('visible');
}

function closeAttachmentSheet() {
  els.attachmentOverlay.classList.remove('visible');
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataURL) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('无法解析照片，请换一张图片重试'));
    image.src = dataURL;
  });
}

async function compressImage(file) {
  const original = await readAsDataURL(file);
  const image = await loadImage(original);
  const maxDimension = 1600;
  const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  const dataURL = canvas.toDataURL('image/jpeg', 0.82);
  return {
    id: makeId('attachment'),
    name: file.name.replace(/\.[^.]+$/, '') + '.jpg',
    type: 'image/jpeg',
    size: Math.round(dataURL.length * 0.75),
    kind: 'image',
    dataURL
  };
}

function normalizedFileType(file) {
  if (file.type) return file.type;
  const extension = file.name.split('.').pop()?.toLowerCase();
  const types = {
    pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
    json: 'application/json', xml: 'text/xml', html: 'text/html', rtf: 'application/rtf',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  };
  return types[extension] || 'application/octet-stream';
}

function supportedDocument(file) {
  const extension = file.name.split('.').pop()?.toLowerCase();
  return ['pdf', 'txt', 'md', 'csv', 'json', 'xml', 'html', 'rtf', 'doc', 'docx'].includes(extension) || file.type.startsWith('text/');
}

async function makeFileAttachment(file) {
  if (!supportedDocument(file)) throw new Error(`暂不支持 ${file.name}；请选择 PDF、Word 或文本类文件`);
  return {
    id: makeId('attachment'),
    name: file.name,
    type: normalizedFileType(file),
    size: file.size,
    kind: 'file',
    dataURL: await readAsDataURL(file)
  };
}

async function handleSelectedFiles(fileList, imageOnly = false) {
  closeAttachmentSheet();
  const files = [...fileList];
  if (!files.length) return;
  if (pendingAttachments.length + files.length > MAX_ATTACHMENTS) {
    showError(`每条消息最多上传 ${MAX_ATTACHMENTS} 个附件`);
    return;
  }
  showError();
  showStatus('正在处理附件…');
  try {
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name} 超过 10 MB`);
      const attachment = imageOnly || file.type.startsWith('image/')
        ? await compressImage(file)
        : await makeFileAttachment(file);
      const total = pendingAttachments.reduce((sum, item) => sum + item.size, 0) + attachment.size;
      if (total > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error('附件总大小不能超过 16 MB');
      pendingAttachments.push(attachment);
      await storeAttachmentData(attachment);
    }
    renderPendingAttachments();
    syncSend();
  } catch (error) {
    showError(error.message || String(error));
  } finally {
    showStatus();
  }
}

function messageTextForAPI(message) {
  const names = (message.attachments || []).map(item => item.name);
  if (!names.length) return message.content;
  return `${message.content || '请分析附件。'}\n\n[附件：${names.join('、')}]`;
}

function isLocalAssistant(message) {
  return message.role === 'assistant' && (
    message.local ||
    message.content === welcome ||
    message.content.startsWith('完整 API Key 已从二维码导入')
  );
}

function apiContentForMessage(message) {
  if (message.role === 'assistant') {
    return [{ type: 'output_text', text: message.content }];
  }
  const content = [{ type: 'input_text', text: messageTextForAPI(message) }];
  (message.attachments || []).forEach(attachment => {
    if (!attachment.dataURL) return;
    if (attachment.kind === 'image') {
      content.push({ type: 'input_image', image_url: attachment.dataURL });
    } else {
      content.push({ type: 'input_file', filename: attachment.name, file_data: attachment.dataURL });
    }
  });
  return content;
}

async function callResponses(instructions, inputMessages, signal) {
  const apiMessages = inputMessages.filter(item => !isLocalAssistant(item)).slice(-20);
  await hydrateAttachments(apiMessages);
  const response = await fetch(`${settings.baseURL}/responses`, {
    method: 'POST',
    signal,
    headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: settings.model,
      instructions,
      input: apiMessages.map(item => ({ role: item.role, content: apiContentForMessage(item) })),
      reasoning: { effort: settings.effort },
      stream: false
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    let detail = body?.error?.message || body?.message;
    if (body?.error?.cause) {
      try { detail = JSON.parse(body.error.cause)?.error?.message || body.error.cause; }
      catch { detail = body.error.cause; }
    }
    throw new Error(detail || `请求失败（HTTP ${response.status}）`);
  }
  if (body.error) throw new Error(body.error.message || body.error.code || '接口返回错误');
  const text = body.output_text || (body.output || []).flatMap(item => item.content || [])
    .filter(item => item.type === 'output_text' || item.type === 'text')
    .map(item => item.text || '').join('\n');
  if (!text.trim()) throw new Error('模型没有返回文本内容');
  return text;
}

function mentionedTargets(prompt) {
  const lower = prompt.toLocaleLowerCase();
  const roles = roleAgents
    .filter(agent => [agent.mention, ...agent.aliases].some(value => lower.includes(value.toLocaleLowerCase())))
    .map(agent => ({ kind: 'role', id: agent.id, name: agent.name, instructions: agent.instructions }));
  const chats = conversations
    .filter(conversation => conversation.id !== activeConversationId && prompt.includes(conversationMention(conversation)))
    .map(conversation => ({ kind: 'conversation', id: conversation.id, name: conversation.title, conversation }));
  return [...roles, ...chats];
}

async function runTarget(target, prompt, context, attachments, signal) {
  if (target.kind === 'conversation') {
    const branchInstructions = `你代表历史对话“${target.name}”。请基于该对话已有上下文处理当前对话交给你的任务。只输出你的独立分析或答案，不要假装拥有未提供的工具。`;
    const branchMessages = [
      ...target.conversation.messages,
      { role: 'user', content: `来自另一个对话的任务：\n${prompt}`, attachments }
    ];
    return callResponses(branchInstructions, branchMessages, signal);
  }
  return callResponses(target.instructions, [{
    role: 'user',
    content: `当前对话上下文：\n${context}\n\n本轮任务：\n${prompt}`,
    attachments
  }], signal);
}

async function answer(prompt, targets, signal, transcript, attachments) {
  if (!targets.length) return callResponses(coordinatorInstructions, transcript, signal);

  const context = transcript.slice(-10).map(item =>
    `${item.role === 'user' ? '用户' : '助手'}：${messageTextForAPI(item)}`
  ).join('\n');

  const reports = await Promise.all(targets.map(async target => ({
    target,
    content: await runTarget(target, prompt, context, attachments, signal)
  })));
  const reportText = reports.map(item => `### ${item.target.kind === 'conversation' ? '对话' : 'Agent'}：${item.target.name}\n${item.content}`).join('\n\n');
  const synthesis = `用户原始请求：\n${prompt}\n\n以下是被提及目标的独立报告：\n${reportText}\n\n请直接给用户一份统一答案。消除重复，明确分歧，并说明结论来自哪些被提及的 Agent 或历史对话。`;
  return callResponses(coordinatorInstructions, [{ role: 'user', content: synthesis }], signal);
}

async function send() {
  if (busy) { controller?.abort(); return; }
  const typed = els.prompt.value.trim();
  if (!typed && !pendingAttachments.length) return;
  if (!settings.apiKey) { openSettings(); showError('请先粘贴 API Key'); return; }
  if (!keyLooksComplete(settings.apiKey)) { openSettings(); alert('当前 API Key 不完整，请重新导入完整 Key。'); return; }

  const prompt = typed || '请分析这些附件。';
  const attachments = pendingAttachments;
  const targets = mentionedTargets(prompt);
  const conversation = activeConversation();
  if (!conversation.messages.some(item => item.role === 'user')) {
    conversation.title = uniqueConversationTitle(titleFromPrompt(prompt, attachments), conversation.id);
  }

  const userMessage = { role: 'user', content: prompt, attachments, time: Date.now() };
  messages.push(userMessage);
  conversation.updatedAt = Date.now();
  const transcript = [...messages];
  pendingAttachments = [];
  els.prompt.value = '';
  resizePrompt();
  renderPendingAttachments();
  renderMessages();
  renderHistory();
  saveState();

  busy = true;
  controller = new AbortController();
  syncSend();
  showError();
  showStatus(targets.length ? `${targets.map(item => item.name).join('、')}正在协作…` : '正在思考…');

  try {
    const content = await answer(prompt, targets, controller.signal, transcript, attachments);
    if (controller.signal.aborted) return;
    messages.push({ role: 'assistant', content, author: 'AgentChat', time: Date.now() });
    conversation.updatedAt = Date.now();
    saveState();
    renderMessages();
    renderHistory();
  } catch (error) {
    if (error.name !== 'AbortError') showError(error.message || String(error));
  } finally {
    busy = false;
    controller = null;
    showStatus();
    syncSend();
  }
}

function renderAll() {
  renderMessages();
  hydrateAttachments(messages).then(renderMessages);
  renderRoleAgents();
  renderHistory();
  renderPendingAttachments();
  renderMentionMenu();
  syncSend();
}

$('toggle-history').addEventListener('click', openHistory);
$('close-history').addEventListener('click', closeHistory);
els.historyBackdrop.addEventListener('click', closeHistory);
$('history-new').addEventListener('click', startNewChat);
$('new-chat').addEventListener('click', startNewChat);
$('open-settings').addEventListener('click', openSettings);
$('save-settings').addEventListener('click', saveSettings);
$('clear-key').addEventListener('click', () => { settings.apiKey = ''; els.apiKey.value = ''; saveState(); });
els.settingsOverlay.addEventListener('click', event => {
  if (event.target === els.settingsOverlay && settings.apiKey) els.settingsOverlay.classList.remove('visible');
});

els.attach.addEventListener('click', openAttachmentSheet);
$('close-attachments').addEventListener('click', closeAttachmentSheet);
els.attachmentOverlay.addEventListener('click', event => {
  if (event.target === els.attachmentOverlay) closeAttachmentSheet();
});
$('take-photo').addEventListener('click', () => { closeAttachmentSheet(); els.cameraInput.value = ''; els.cameraInput.click(); });
$('choose-photo').addEventListener('click', () => { closeAttachmentSheet(); els.photoInput.value = ''; els.photoInput.click(); });
$('choose-file').addEventListener('click', () => { closeAttachmentSheet(); els.fileInput.value = ''; els.fileInput.click(); });
els.cameraInput.addEventListener('change', () => handleSelectedFiles(els.cameraInput.files, true));
els.photoInput.addEventListener('change', () => handleSelectedFiles(els.photoInput.files, true));
els.fileInput.addEventListener('change', () => handleSelectedFiles(els.fileInput.files, false));

els.prompt.addEventListener('input', () => { resizePrompt(); renderMentionMenu(); syncSend(); });
els.prompt.addEventListener('keydown', event => {
  if (event.key === 'Escape') els.mentionMenu.classList.remove('visible');
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !els.mentionMenu.classList.contains('visible')) {
    event.preventDefault(); send();
  }
});
els.send.addEventListener('click', send);
$('close-tip').addEventListener('click', () => {
  els.installTip.style.display = 'none';
  localStorage.setItem('agentchat.installTipClosed', '1');
});

const keyImported = importKeyFromFragment();
if (keyImported) {
  messages.push({ role: 'assistant', content: '完整 API Key 已从二维码导入，并已从地址栏清除。现在可以直接聊天。', author: 'AgentChat', local: true, time: Date.now() });
  activeConversation().updatedAt = Date.now();
  saveState();
}

renderAll();
const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
if (!standalone && !localStorage.getItem('agentchat.installTipClosed')) els.installTip.style.display = 'block';
if (!settings.apiKey) openSettings();

console.info(`AgentChat ${APP_VERSION} ready`);
