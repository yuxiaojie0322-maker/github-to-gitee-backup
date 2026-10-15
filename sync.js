const https = require('https');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const GH_TOKEN = process.env.GH_TOKEN;
const GITEE_USER = process.env.GITEE_USER || 'path-of-the-little-phoenix';
const GITEE_TOKEN = process.env.GITEE_TOKEN;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

if (!GH_TOKEN || !GITEE_TOKEN) {
  console.error('❌ GH_TOKEN or GITEE_TOKEN is missing!');
  process.exit(1);
}

function httpsRequest(options, data = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(body) });
        } catch(e) {
          resolve({ status: res.statusCode, headers: res.headers, data: body });
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (data) {
      req.write(typeof data === 'string' ? data : JSON.stringify(data));
    }
    req.end();
  });
}

async function safeHttpsRequest(options, data = null, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await httpsRequest(options, data);
    } catch(err) {
      console.warn(`[Network Retry] 请求出错 (${err.message})，正在进行第 ${i + 1}/${retries} 次重试...`);
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
}

async function sendTelegram(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  try {
    const postData = JSON.stringify({
      chat_id: TG_CHAT_ID,
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
    await safeHttpsRequest({
      hostname: 'api.telegram.org',
      path: `/bot${TG_BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, postData, 2);
    console.log('📢 Telegram 结果通知已发送');
  } catch(e) {
    console.error('Telegram push failed:', e.message);
  }
}

async function getAllGithubRepos() {
  let allRepos = [];
  let page = 1;
  while (true) {
    const res = await safeHttpsRequest({
      hostname: 'api.github.com',
      path: `/user/repos?per_page=100&page=${page}&affiliation=owner`,
      method: 'GET',
      headers: {
        'User-Agent': 'SyncScript',
        'Authorization': `token ${GH_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });

    if (res.status !== 200 || !Array.isArray(res.data)) {
      console.error('Failed to fetch repos from GitHub:', res.status, res.data);
      break;
    }
    allRepos.push(...res.data);
    if (res.data.length < 100) break;
    page++;
  }
  return allRepos;
}

async function ensureGiteeRepo(repo) {
  try {
    const checkRes = await safeHttpsRequest({
      hostname: 'gitee.com',
      path: `/api/v5/repos/${GITEE_USER}/${encodeURIComponent(repo.name)}?access_token=${GITEE_TOKEN}`,
      method: 'GET',
      headers: { 'User-Agent': 'SyncScript' }
    });

    if (checkRes.status === 200) {
      return true; // Already exists
    }

    // Create repo on Gitee
    console.log(`[Gitee] 正在新建仓库: ${repo.name} (私有: ${repo.private})...`);
    const createRes = await safeHttpsRequest({
      hostname: 'gitee.com',
      path: '/api/v5/user/repos',
      method: 'POST',
      headers: {
        'User-Agent': 'SyncScript',
        'Content-Type': 'application/json'
      }
    }, {
      access_token: GITEE_TOKEN,
      name: repo.name,
      description: repo.description || 'Mirrored from GitHub',
      private: repo.private,
      has_issues: true,
      has_wiki: false
    });

    if (createRes.status === 201) {
      console.log(`[Gitee] 新建仓库成功: ${repo.name}`);
      return true;
    } else {
      console.error(`[Gitee] 新建仓库失败: ${repo.name}, 状态码: ${createRes.status}`, createRes.data);
      return false;
    }
  } catch(e) {
    console.error(`[Gitee API Error] 检查/创建仓库异常: ${repo.name}:`, e.message);
    return false;
  }
}

async function main() {
  const startTime = new Date();
  const timeStr = startTime.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  console.log(`=== 开始执行 GitHub -> Gitee 自动镜像同步 [${timeStr}] ===`);

  const repos = await getAllGithubRepos();
  console.log(`共获取到 GitHub 个人仓库: ${repos.length} 个`);

  let successCount = 0;
  let failCount = 0;
  const failedList = [];

  for (let i = 0; i < repos.length; i++) {
    const repo = repos[i];
    // 跳过备份项目本身以避免自循环
    if (repo.name === 'github-to-gitee-backup') {
      continue;
    }

    console.log(`\n[${i + 1}/${repos.length}] 正在同步: ${repo.name} (${repo.private ? '🔒 私有' : '🌐 公开'})...`);
    const tempDir = path.join(process.cwd(), `mirror_${repo.name}`);
    const cloneUrl = `https://${GH_TOKEN}@github.com/${repo.full_name}.git`;
    const pushUrl = `https://${encodeURIComponent(GITEE_USER)}:${encodeURIComponent(GITEE_TOKEN)}@gitee.com/${GITEE_USER}/${encodeURIComponent(repo.name)}.git`;

    try {
      const ready = await ensureGiteeRepo(repo);
      if (!ready) {
        failCount++;
        failedList.push(`${repo.name}(创建失败)`);
        continue;
      }

      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }

      // Clone mirror (包含全部分支、Tag与版本提交)，单库超时延长到 10 分钟 (600000ms)
      execSync(`git clone --mirror --quiet "${cloneUrl}" "${tempDir}"`, { stdio: 'inherit', timeout: 600000 });

      // Push mirror to Gitee
      execSync(`git -C "${tempDir}" push --mirror --force --quiet "${pushUrl}"`, { stdio: 'inherit', timeout: 600000 });

      successCount++;
      console.log(`✅ ${repo.name} 镜像同步成功`);
    } catch(err) {
      failCount++;
      failedList.push(repo.name);
      console.error(`❌ ${repo.name} 同步出错:`, err.message);
    } finally {
      if (fs.existsSync(tempDir)) {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch(e) {}
      }
    }
  }

  const duration = Math.round((new Date() - startTime) / 1000);
  console.log(`\n=== 镜像同步完成！成功: ${successCount}, 失败: ${failCount}, 耗时: ${duration}s ===`);

  const tgMessage = `🚀 <b>GitHub → Gitee 全仓库同步完成</b>\n\n` +
    `✅ <b>成功同步</b>: <code>${successCount}</code> 个仓库\n` +
    (failCount > 0 ? `⚠️ <b>个别失败</b>: <code>${failCount}</code> 个 (${failedList.join(', ')})\n` : `🎉 <b>所有仓库 100% 完整镜像就绪</b>\n`) +
    `⏱️ <b>总耗时</b>: ${duration} 秒\n` +
    `🕒 <b>同步时间</b>: ${timeStr}\n` +
    `🔗 <b>Gitee 空间</b>: <a href="https://gitee.com/${GITEE_USER}">gitee.com/${GITEE_USER}</a>`;

  await sendTelegram(tgMessage);
}

main().catch(async (e) => {
  console.error('Fatal sync error:', e);
  await sendTelegram(`⚠️ <b>GitHub → Gitee 镜像同步失败</b>\n\n异常: ${e.message}`);
  process.exit(1);
});
