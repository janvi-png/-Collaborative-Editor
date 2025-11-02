// client.js
const socket = io();

// UI references
const docIdInput = document.getElementById("docId");
const joinBtn = document.getElementById("joinBtn");
const presenceEl = document.getElementById("presence");
const editor = document.getElementById("editor");
const imgUpload = document.getElementById("imgUpload");
const versionList = document.getElementById("versionList");
const chatMessages = document.getElementById("chatMessages");
const chatInput = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");
const typingStatus = document.getElementById("typingStatus");
const downloadTxtBtn = document.getElementById("downloadTxt");
const downloadPdfBtn = document.getElementById("downloadPdf");
const replayBtn = document.getElementById("replayBtn");
const fontSelect = document.getElementById("toolbarFont");
const fontFamilySelect = document.getElementById("fontFamily");
const fontSizeSelect = document.getElementById("fontSize");
const popup = document.getElementById("popup");
const viewAllBtn = document.getElementById("viewAllBtn");

let docId = null;
let myName = prompt("Enter your name (or leave blank for auto-name):");
if (!myName || !myName.trim()) {
  myName = "User" + Math.floor(Math.random() * 9000 + 100);
}
socket.emit("set-name", myName);

// join logic
joinBtn.addEventListener("click", () => {
  const id = docIdInput.value.trim();
  if (!id) return alert("Enter a Doc ID (like doc1)");
  docId = id;
  socket.emit("join-doc", docId);
});

// auto-join if URL has /doc/:id
(function autoJoinFromPath() {
  const parts = location.pathname.split("/");
  if (parts[1] === "doc" && parts[2]) {
    docId = decodeURIComponent(parts[2]);
    docIdInput.value = docId;
    socket.emit("join-doc", docId);
  }
})();

// simple exec command helper
function exec(cmd, value = null) {
  document.execCommand(cmd, false, value);
  // send change
  if (docId) socket.emit("text-change", { docId, content: editor.innerHTML });
}

// toolbar listeners
fontSelect.addEventListener("change", () => {
  exec("fontName", fontSelect.value);
});
fontFamilySelect.addEventListener("change", () => {
  // apply to whole doc
  editor.style.fontFamily = fontFamilySelect.value;
});
fontSizeSelect.addEventListener("change", () => {
  exec("fontSize", fontSizeSelect.value); // value 1-7 or as used
});

// content sync
let isTypingEditor = false;
editor.addEventListener("input", () => {
  if (!docId) return;
  isTypingEditor = true;
  socket.emit("text-change", { docId, content: editor.innerHTML });
  setTimeout(() => { isTypingEditor = false; }, 200);
});

// chat send
sendBtn.addEventListener("click", () => {
  if (!docId) return alert("Join a doc first");
  const m = chatInput.value.trim();
  if (!m) return;
  socket.emit("chat-message", { docId, msg: m });
  chatInput.value = "";
});
chatInput.addEventListener("input", () => {
  if (!docId) return;
  socket.emit("typing", { docId });
});

// image upload -> insert inline as element (draggable)
imgUpload.addEventListener("change", (e) => {
  if (!docId) return alert("Join a doc first");
  const f = e.target.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = document.createElement("img");
    img.src = reader.result;
    img.className = "embedded-img";
    img.setAttribute("draggable", "true");
    // allow dragging within contenteditable - default behavior works in many browsers.
    // We add a simple drag handler to enable repositioning via drop.
    img.addEventListener("dragstart", (ev) => {
      ev.dataTransfer.setData("text/plain", "dragging-image");
      window._draggingImg = img;
    });
    editor.appendChild(img);
    socket.emit("text-change", { docId, content: editor.innerHTML });
  };
  reader.readAsDataURL(f);
});

// handle drop reposition within editor
editor.addEventListener("dragover", (e) => {
  e.preventDefault();
});
editor.addEventListener("drop", (e) => {
  e.preventDefault();
  const dragging = window._draggingImg;
  if (!dragging) return;
  // get caret position and insert before node at caret
  const range = caretRangeFromPoint(e.clientX, e.clientY);
  if (range) {
    range.insertNode(dragging);
    socket.emit("text-change", { docId, content: editor.innerHTML });
  }
  window._draggingImg = null;
});

// caret helper
function caretRangeFromPoint(x, y) {
  if (document.caretRangeFromPoint) {
    return document.caretRangeFromPoint(x, y);
  } else if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    const range = document.createRange();
    range.setStart(pos.offsetNode, pos.offset);
    range.collapse(true);
    return range;
  }
  return null;
}

// downloads
downloadTxtBtn.addEventListener("click", () => {
  if (!docId) return alert("Join a doc first");
  // Save innerHTML as txt (so images are kept as data URLs inside the html text)
  const blob = new Blob([editor.innerHTML], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${docId || "document"}.txt`;
  a.click();
});
downloadPdfBtn.addEventListener("click", () => {
  if (!docId) return alert("Join a doc first");
  // Use html2pdf to include images
  const opt = { margin: 0.5, filename: `${docId || "document"}.pdf`, html2canvas: { scale: 2 } };
  html2pdf().set(opt).from(editor).save();
});

// replay (basic)
replayBtn.addEventListener("click", () => {
  const text = editor.innerText;
  editor.innerHTML = "";
  let i = 0;
  const t = setInterval(() => {
    editor.innerText += text[i++] || "";
    if (i >= text.length) clearInterval(t);
  }, 25);
});

// presence + socket events
socket.on("presence-update", (count) => {
  presenceEl.textContent = `👥 Currently editing: ${count}`;
});

// init doc content
socket.on("init-doc", ({ docId: incoming, content }) => {
  // only set if matching docId
  if (docId && incoming === docId) {
    editor.innerHTML = content || "";
  }
});

// incoming live updates
socket.on("update-text", ({ docId: incoming, content }) => {
  if (!docId || incoming !== docId) return;
  if (!isTypingEditor) editor.innerHTML = content;
});

// history rendering (right panel)
socket.on("history-data", (versions) => {
  versionList.innerHTML = "";
  if (!versions || !versions.length) {
    versionList.innerHTML = "<div class='small'>No versions yet</div>";
    return;
  }
  // show newest first
  versions.slice().reverse().forEach((v, idx) => {
    const realIndex = versions.length - 1 - idx;
    const div = document.createElement("div");
    div.className = "version-item";
    div.innerHTML = `
      <div style="font-weight:600">v${realIndex + 1}</div>
      <div class="version-meta">${v.editedBy || "Unknown"} • ${new Date(v.versionAt).toLocaleString()}</div>
      <div style="margin-top:6px;">
        <button class="viewBtn" data-index="${realIndex}">View</button>
        <button class="restoreBtn" data-index="${realIndex}">Restore</button>
      </div>
    `;
    versionList.appendChild(div);
  });
});

// view & restore handlers
versionList.addEventListener("click", (e) => {
  const viewBtn = e.target.closest(".viewBtn");
  if (viewBtn) {
    const index = parseInt(viewBtn.dataset.index);
    socket.emit("view-version", { docId, index });
    return;
  }
  const restoreBtn = e.target.closest(".restoreBtn");
  if (restoreBtn) {
    const index = parseInt(restoreBtn.dataset.index);
    if (!confirm("Restore this version and broadcast to everyone?")) return;
    socket.emit("restore-version", { docId, index });
    return;
  }
});

// show version in popup
socket.on("version-view", ({ index, version }) => {
  if (!version) return alert("Version not found");
  popup.style.display = "block";
  popup.innerHTML = `
    <div class="popup" id="popupRoot">
      <div class="card" style="padding:16px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div><b>Version v${index+1}</b> • ${version.editedBy || 'Unknown'} • ${new Date(version.versionAt).toLocaleString()}</div>
          <div><button id="closePopup">Close</button></div>
        </div>
        <hr />
        <div style="margin-top:10px;">
          <div><b>Content:</b></div>
          <div style="margin-top:8px;">${version.content}</div>
        </div>
      </div>
    </div>
  `;
  document.getElementById("closePopup").onclick = () => { popup.style.display = "none"; popup.innerHTML = ""; };
});

// when version is restored, update editor content
socket.on("version-restored", ({ content }) => {
  editor.innerHTML = content;
});

// chat messages
socket.on("chat-message", ({ who, msg, at }) => {
  // server sends object; but older format may send line object
  const whoName = who || (msg?.who) || (typeof who === "string" ? who : "Unknown");
  const text = msg || (typeof msg === "string" ? msg : "");
  const avatar = (whoName && whoName[0]) ? whoName[0].toUpperCase() : "U";
  const row = document.createElement("div");
  row.className = "chat-row";
  row.innerHTML = `<div class="avatar" style="background:${stringToColor(whoName)}">${avatar}</div>
                   <div><div style="font-weight:600">${whoName}</div><div class="chat-message">${text}</div></div>`;
  chatMessages.appendChild(row);
  chatMessages.scrollTop = chatMessages.scrollHeight;
});

// chat-history (on join)
socket.on("chat-history", (arr) => {
  chatMessages.innerHTML = "";
  if (!arr || !arr.length) return;
  arr.forEach(line => {
    if (typeof line === "string") {
      const split = line.split(":");
      const who = split.shift();
      const msg = split.join(":");
      const avatar = who[0]?.toUpperCase() || "U";
      const row = document.createElement("div");
      row.className = "chat-row";
      row.innerHTML = `<div class="avatar" style="background:${stringToColor(who)}">${avatar}</div>
                       <div><div style="font-weight:600">${who}</div><div class="chat-message">${msg}</div></div>`;
      chatMessages.appendChild(row);
    } else if (line.who) {
      // persisted as object {who,msg,at}
      const avatar = (line.who && line.who[0]) ? line.who[0].toUpperCase() : "U";
      const row = document.createElement("div");
      row.className = "chat-row";
      row.innerHTML = `<div class="avatar" style="background:${stringToColor(line.who)}">${avatar}</div>
                       <div><div style="font-weight:600">${line.who}</div><div class="chat-message">${line.msg}</div></div>`;
      chatMessages.appendChild(row);
    }
  });
  chatMessages.scrollTop = chatMessages.scrollHeight;
});

// typing indicator
socket.on("typing", (who) => {
  typingStatus.innerText = `${who} is typing...`;
  clearTimeout(window._typingTimer);
  window._typingTimer = setTimeout(() => { typingStatus.innerText = ""; }, 1400);
});

// cursor label (brief floating label)
socket.on("cursor-update", ({ socketId, who, position, color }) => {
  const labelId = `cursor-${socketId}`;
  const prev = document.getElementById(labelId);
  if (prev) prev.remove();
  const span = document.createElement("div");
  span.id = labelId;
  span.className = "cursor-label";
  span.style.background = color || "#1e88e5";
  span.textContent = who || "User";
  document.body.appendChild(span);
  // approximate position relative to editor bounding box
  const rect = editor.getBoundingClientRect();
  // basic positioning: position as characters count -> row/col approx
  const approxCol = (position % 60) * 7;
  const approxRow = Math.floor(position / 60) * 18;
  span.style.left = (rect.left + approxCol) + "px";
  span.style.top = (rect.top + approxRow) + "px";
  setTimeout(() => { const el = document.getElementById(labelId); if (el) el.remove(); }, 900);
});

// helper to convert string to consistent color
function stringToColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  const h = Math.abs(hash) % 360;
  return `hsl(${h},70%,45%)`;
}

// view latest versions button
viewAllBtn.addEventListener("click", () => {
  window.open(location.href, "_blank");
});

window.addEventListener("beforeunload", () => {
  // optionally notify server (disconnect handled)
});
