
const $ = id => document.getElementById(id);

let adminKey = sessionStorage.getItem("adminKey") || "";
let selectedUser = null;

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-admin-key": adminKey,
      ...(options.headers || {})
    }
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }

  return data;
}

function showDashboard() {
  $("loginBox").hidden = true;
  $("dashboard").hidden = false;
}

async function login() {
  adminKey = $("adminKey").value.trim();

  if (!adminKey) {
    $("loginError").textContent = "Admin Key দিন";
    return;
  }

  try {
    await api("/api/users");
    sessionStorage.setItem("adminKey", adminKey);
    showDashboard();
    await loadUsers();
  } catch (err) {
    adminKey = "";
    $("loginError").textContent = "ভুল Admin Key!";
  }
}

$("loginBtn").onclick = login;

$("adminKey").addEventListener("keydown", e => {
  if (e.key === "Enter") login();
});

$("logoutBtn").onclick = () => {
  sessionStorage.removeItem("adminKey");
  location.reload();
};

async function loadUsers() {
  try {
    const users = await api("/api/users");

    $("userList").replaceChildren();

    users.forEach(user => {
      const item = document.createElement("div");
      item.className = "user-item";

      if (selectedUser &&
          selectedUser.chat_id === user.chat_id) {
        item.classList.add("active");
      }

      const name = document.createElement("strong");
      name.textContent = user.first_name || "Unknown User";

      const username = document.createElement("small");
      username.textContent = user.username
        ? "@" + user.username
        : "ID: " + user.chat_id;

      const last = document.createElement("small");
      last.textContent = user.last_message || "No messages";

      item.append(name, username, last);

      if (user.banned) {
        const badge = document.createElement("small");
        badge.textContent = "BLOCKED";
        badge.style.color = "red";
        item.append(badge);
      }

      item.onclick = () => selectUser(user);
      $("userList").append(item);
    });

    if (selectedUser) {
      const updated = users.find(
        u => u.chat_id === selectedUser.chat_id
      );

      if (updated) selectedUser = updated;
      else selectedUser = null;
    }

    if (selectedUser) {
      updateSelectedUser();
    }

  } catch (err) {
    console.error(err);
  }
}

function selectUser(user) {
  selectedUser = user;
  updateSelectedUser();
  loadMessages();
  loadUsers();
}

function updateSelectedUser() {
  if (!selectedUser) return;

  $("selectedName").textContent =
    selectedUser.first_name +
    " (ID: " + selectedUser.chat_id + ")";

  $("replyInput").disabled = false;
  $("sendBtn").disabled = false;
  $("banBtn").hidden = false;

  $("banBtn").textContent =
    selectedUser.banned ? "Unban User" : "Ban User";

  $("banBtn").style.background =
    selectedUser.banned ? "#159b65" : "#e34d59";
}

async function loadMessages() {
  if (!selectedUser) return;

  try {
    const chatId = selectedUser.chat_id;
    const messages = await api(
      "/api/messages/" + encodeURIComponent(chatId)
    );

    if (!selectedUser || selectedUser.chat_id !== chatId) return;

    const box = $("messages");
    box.replaceChildren();

    messages.forEach(message => {
      const div = document.createElement("div");
      div.className = "msg " +
        (message.direction === "admin" ? "admin" : "user");

      const content = document.createElement("span");
      content.textContent = message.message;

      const time = document.createElement("small");
      time.textContent =
        message.direction.toUpperCase() +
        " • " + message.created_at;

      div.append(content, time);
      box.append(div);
    });

    box.scrollTop = box.scrollHeight;

  } catch (err) {
    console.error(err);
  }
}

// Admin reply
$("replyForm").onsubmit = async e => {
  e.preventDefault();

  if (!selectedUser) return;

  const message = $("replyInput").value.trim();

  if (!message) return;

  $("sendBtn").disabled = true;

  try {
    await api("/api/reply", {
      method: "POST",
      body: JSON.stringify({
        chatId: selectedUser.chat_id,
        message
      })
    });

    $("replyInput").value = "";
    await loadMessages();

  } catch (err) {
    alert(err.message);
  } finally {
    $("sendBtn").disabled = false;
  }
};

// Ban / Unban
$("banBtn").onclick = async () => {
  if (!selectedUser) return;

  const nextState = !selectedUser.banned;

  if (!confirm(nextState
      ? "এই ইউজারকে Ban করবেন?"
      : "এই ইউজারকে Unban করবেন?")) return;

  try {
    await api("/api/ban", {
      method: "POST",
      body: JSON.stringify({
        chatId: selectedUser.chat_id,
        banned: nextState
      })
    });

    selectedUser.banned = nextState;
    updateSelectedUser();
    await loadUsers();

  } catch (err) {
    alert(err.message);
  }
};

// Group / Channel Broadcast
$("broadcastBtn").onclick = async () => {
  const target = $("target").value.trim();
  const message = $("broadcastMessage").value.trim();

  if (!target || !message) {
    alert("Target এবং Message দিন");
    return;
  }

  $("broadcastBtn").disabled = true;
  $("broadcastStatus").textContent = "Sending...";

  try {
    await api("/api/broadcast", {
      method: "POST",
      body: JSON.stringify({ target, message })
    });

    $("broadcastStatus").textContent = "Message sent successfully!";
    $("broadcastMessage").value = "";

  } catch (err) {
    $("broadcastStatus").textContent = "Error: " + err.message;
  } finally {
    $("broadcastBtn").disabled = false;
  }
};

// Auto refresh
if (adminKey) {
  showDashboard();

  api("/api/users")
    .then(loadUsers)
    .catch(() => {
      sessionStorage.removeItem("adminKey");
      $("dashboard").hidden = true;
      $("loginBox").hidden = false;
    });
}

setInterval(() => {
  if (adminKey && !selectedUser) loadUsers();
  else if (adminKey && selectedUser) {
    loadUsers();
    loadMessages();
  }
}, 5000);
