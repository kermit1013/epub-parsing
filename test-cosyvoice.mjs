#!/usr/bin/env node
/**
 * CosyVoice Gradio API 測試腳本
 * 使用「3s極速複刻」模式
 *
 * 使用方式:
 *   node test-cosyvoice.mjs
 *
 * 可選參數:
 *   --url <url>              Gradio 伺服器位址（預設: http://100.84.200.122:50000）
 *   --prompt-audio <path>    參考音頻路徑，需 ≥16kHz（預設: ./input/prompt.wav）
 *   --prompt-text <text>     參考音頻對應的文字
 *   --text <text>            要合成的文字
 *   --output <path>          輸出路徑（預設: ./output/cosyvoice_test.wav）
 *   --speed <number>         語速（預設: 1）
 *   --seed <number>          隨機種子（預設: 0 = 自動產生）
 */

import { Client } from '@gradio/client';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

// ─── 設定區（可自行修改）──────────────────────────────────────────
const CONFIG = {
  gradioUrl:       'http://100.84.200.122:50000',
  promptAudioPath: './input/prompt.wav',
  promptText:      '我们常常把 1989 年 6 月 3 号晚上到 6 月 4 号早上发生的军事镇压称为「天安门事件」或「天安门屠杀」',
  testText:        '这是一部惊心动魄的灾难纪实，以细腻而写实的笔触呈现一场规模空前的世纪野火。二○一六年五月，加拿大石油产业重镇——麦克默里堡（Fort McMurray）——同时也是美国最大海外石油供应产地，遭到野火侵袭。这场损失高达数十亿美元的世纪灾难，在短短一个下午，熔毁无数车辆，将整片社区变成汽油弹，迫使八万八千名居民紧急撤离家园。约翰．维扬透过这场破坏力堪比卡崔娜飓风的浩劫大火向世人示警：这绝非单一偶发事件，而是骇人的预兆，提醒我们必须准备面对未来一个愈来愈热、更容易着火的世界。',
  outputPath:      './output/cosyvoice_test.wav',
  speed:           0.85,
  seed:            0,   // 0 = 每次隨機產生
};
// ─────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--url':          CONFIG.gradioUrl       = args[++i]; break;
      case '--prompt-audio': CONFIG.promptAudioPath = args[++i]; break;
      case '--prompt-text':  CONFIG.promptText      = args[++i]; break;
      case '--text':         CONFIG.testText        = args[++i]; break;
      case '--output':       CONFIG.outputPath      = args[++i]; break;
      case '--speed':        CONFIG.speed           = parseFloat(args[++i]); break;
      case '--seed':         CONFIG.seed            = parseInt(args[++i]); break;
    }
  }
}

// ── m3u8 串流下載：抓取所有片段並合併 ────────────────────────────────────────
async function downloadM3u8(m3u8Url, outputPath) {
  console.log('   偵測到 m3u8 串流，解析片段中...');

  // 取得 base URL（去掉 playlist.m3u8）
  const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);

  // 下載 m3u8 播放清單
  const playlistResp = await fetch(m3u8Url, { signal: AbortSignal.timeout(30000) });
  if (!playlistResp.ok) throw new Error(`無法下載 m3u8: HTTP ${playlistResp.status}`);
  const playlist = await playlistResp.text();

  // 解析片段 URL（非 # 開頭的行）
  const segments = playlist
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));

  if (segments.length === 0) throw new Error('m3u8 播放清單中沒有找到片段！\n' + playlist);

  console.log(`   找到 ${segments.length} 個音頻片段，下載中...`);

  const buffers = [];
  for (let i = 0; i < segments.length; i++) {
    const segUrl = segments[i].startsWith('http') ? segments[i] : baseUrl + segments[i];
    const segResp = await fetch(segUrl, { signal: AbortSignal.timeout(30000) });
    if (!segResp.ok) throw new Error(`片段下載失敗 [${i + 1}]: HTTP ${segResp.status}`);
    buffers.push(Buffer.from(await segResp.arrayBuffer()));
    process.stdout.write(`\r   進度: ${i + 1}/${segments.length}`);
  }
  console.log('');

  // 合併所有片段
  const combined = Buffer.concat(buffers);
  await fs.writeFile(outputPath, combined);
  console.log(`   ✅ 已合併 ${segments.length} 個片段 (${(combined.length / 1024).toFixed(1)} KB)`);
}
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  parseArgs();

  console.log('='.repeat(60));
  console.log('  CosyVoice Gradio 測試（3s 極速複刻）');
  console.log('='.repeat(60));
  console.log(`  Gradio URL  : ${CONFIG.gradioUrl}`);
  console.log(`  Prompt 音頻 : ${CONFIG.promptAudioPath}`);
  console.log(`  Prompt 文本 : ${CONFIG.promptText}`);
  console.log(`  合成文字    : ${CONFIG.testText}`);
  console.log(`  輸出路徑    : ${CONFIG.outputPath}`);
  console.log('='.repeat(60));

  // 1. 確認 prompt 音頻存在
  if (!existsSync(CONFIG.promptAudioPath)) {
    console.error(`\n❌ 找不到 prompt 音頻: ${CONFIG.promptAudioPath}`);
    console.error('   請準備一個 ≥16kHz 的 WAV 檔案，放到 input/prompt.wav\n');
    process.exit(1);
  }

  // 2. 連線到 Gradio
  console.log('\n🔌 連線到 Gradio 伺服器...');
  const client = await Client.connect(CONFIG.gradioUrl);
  console.log('   ✅ 連線成功');

  // 3. 取得隨機種子
  let seed = CONFIG.seed;
  if (seed === 0) {
    const seedResult = await client.predict('/generate_seed', {});
    const raw = seedResult.data[0];
    seed = typeof raw === 'object' ? (raw?.value ?? raw) : raw;
  }
  console.log(`\n🎲 本次種子: ${seed}  (若咬字滿意可記下此數字固定使用)`);

  // 4. 將 prompt 音頻讀成 Blob
  const audioBuffer = await fs.readFile(CONFIG.promptAudioPath);
  const audioBlob = new Blob([audioBuffer], { type: 'audio/wav' });
  console.log(`\n✅ 已讀取 prompt 音頻 (${(audioBuffer.length / 1024).toFixed(1)} KB)`);

  // 5. 呼叫 /generate_audio（3s 極速複刻模式）
  console.log('\n🗣️  呼叫 CosyVoice TTS...');
  const result = await client.predict('/generate_audio', {
    tts_text:             CONFIG.testText,
    mode_checkbox_group:  '3s极速复刻',
    sft_dropdown:         '',
    prompt_text:          CONFIG.promptText,
    prompt_wav_upload:    audioBlob,   // 上傳用
    prompt_wav_record:    audioBlob,   // 錄音用（給同一個）
    instruct_text:        '',
    seed:                 seed,
    stream:               false,
    speed:                CONFIG.speed,
  });

  console.log('   ✅ 合成完成');

  // 6. 儲存音頻
  await fs.mkdir(path.dirname(path.resolve(CONFIG.outputPath)), { recursive: true });

  const data = result.data?.[0];
  if (!data) {
    console.error('\n❌ API 回傳資料為空！');
    console.error('   原始回應:', JSON.stringify(result, null, 2).slice(0, 500));
    process.exit(1);
  }

  // data 可能是 { url, orig_name } 或 { path } 格式
  const audioUrl = data.url || (data.path ? `${CONFIG.gradioUrl}/file=${data.path}` : null);

  if (!audioUrl) {
    console.error('\n❌ 無法取得音頻 URL！');
    console.error('   回傳的 data[0]:', JSON.stringify(data, null, 2));
    process.exit(1);
  }

  console.log(`\n📥 下載音頻: ${audioUrl}`);

  // 判斷是否為 m3u8 串流，還是直接音頻檔案
  if (audioUrl.includes('.m3u8')) {
    // 直接儲存為 .wav，macOS 可正常播放
    await downloadM3u8(audioUrl, CONFIG.outputPath);
  } else {
    const audioResp = await fetch(audioUrl, { signal: AbortSignal.timeout(60000) });
    if (!audioResp.ok) throw new Error(`下載音頻失敗: HTTP ${audioResp.status}`);
    await fs.writeFile(CONFIG.outputPath, Buffer.from(await audioResp.arrayBuffer()));
  }

  console.log(`\n🎉 測試成功！`);
  console.log(`   輸出: ${path.resolve(CONFIG.outputPath)}\n`);
}

main().catch(err => {
  console.error('\n💥 錯誤:', err.message ?? err);
  process.exit(1);
});
