#!/usr/bin/env node
import { EPub } from 'epub2';
import { convert } from 'html-to-text';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import OpenCC from 'opencc';
import { select, input } from '@inquirer/prompts';
import chalk from 'chalk';
import figlet from 'figlet';
import { Client } from '@gradio/client';

// 隱藏來自 epub2 舊版 url.parse 引發的 DeprecationWarning 警告
process.removeAllListeners('warning');

// BookPlayer 的 iCloud 路徑 (自動同步到 iOS)
const BOOKPLAYER_ICLOUD = `${process.env.HOME}/Library/Mobile Documents/iCloud~com~tortugapower~audiobookplayer/Documents`;

// 初始化 OpenCC (繁體轉簡體)
const converter = new OpenCC('t2s.json');

// ── 文本分段邏輯 (按標點符號與長度限制分割) ────────────────────────────────
function chunkText(text, maxLength) {
    const chunks = [];
    let currentChunk = '';
    const sentences = text.split(/(?<=[。！？；\n])/g);

    for (const sentence of sentences) {
        if (!sentence.trim()) continue;
        if (currentChunk.length + sentence.length <= maxLength) {
            currentChunk += sentence;
        } else {
            if (currentChunk) chunks.push(currentChunk.trim());
            currentChunk = sentence;
        }
    }
    if (currentChunk) chunks.push(currentChunk.trim());
    return chunks;
}

// ── m3u8 串流下載：抓取所有片段並合併 ───────────────────────────────────────
async function downloadM3u8(m3u8Url, outputPath) {
    const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);

    const playlistResp = await fetch(m3u8Url, { signal: AbortSignal.timeout(30000) });
    if (!playlistResp.ok) throw new Error(`無法下載 m3u8: HTTP ${playlistResp.status}`);
    const playlist = await playlistResp.text();

    const segments = playlist
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'));

    if (segments.length === 0) throw new Error('m3u8 播放清單中沒有找到片段！\n' + playlist);

    const buffers = [];
    for (const seg of segments) {
        const segUrl = seg.startsWith('http') ? seg : baseUrl + seg;
        const segResp = await fetch(segUrl, { signal: AbortSignal.timeout(30000) });
        if (!segResp.ok) throw new Error(`片段下載失敗: HTTP ${segResp.status}`);
        buffers.push(Buffer.from(await segResp.arrayBuffer()));
    }

    await fs.writeFile(outputPath, Buffer.concat(buffers));
}

// ── CosyVoice TTS 單一 chunk 轉換 ──────────────────────────────────────────
async function synthesizeChunk(client, text, promptAudioBlob, cosyConfig) {
    const result = await client.predict('/generate_audio', {
        tts_text:            text,
        mode_checkbox_group: '3s极速复刻',
        sft_dropdown:        '',
        prompt_text:         cosyConfig.promptText,
        prompt_wav_upload:   promptAudioBlob,
        prompt_wav_record:   promptAudioBlob,
        instruct_text:       '',
        seed:                cosyConfig.seed,
        stream:              false,
        speed:               cosyConfig.speed,
    });

    const data = result.data?.[0];
    if (!data) throw new Error('CosyVoice API 回傳資料為空');

    const audioUrl = data.url || (data.path ? `${cosyConfig.gradioUrl}/file=${data.path}` : null);
    if (!audioUrl) throw new Error(`無法取得音頻 URL，回傳: ${JSON.stringify(data)}`);

    return audioUrl;
}

// ── 將 EPUB 轉換為語音（使用 CosyVoice Gradio） ──────────────────────────────
async function convertEpub(inputArgRaw, startChapter, cosyConfig) {
    const inputArg = path.resolve(process.cwd(), inputArgRaw);
    const bookName = path.basename(inputArg, path.extname(inputArg));
    const outputDir = `./output/${bookName}`;
    const chunkSize = 200;

    await fs.mkdir(outputDir, { recursive: true });

    // 連線 Gradio
    console.log(chalk.cyan('\n🔌 連線到 CosyVoice Gradio 伺服器...'));
    const client = await Client.connect(cosyConfig.gradioUrl);
    console.log(chalk.green('   ✅ 連線成功'));

    // 取得種子
    let seed = cosyConfig.seed;
    if (seed === 0) {
        const seedResult = await client.predict('/generate_seed', {});
        const raw = seedResult.data[0];
        seed = typeof raw === 'object' ? (raw?.value ?? raw) : raw;
    }
    console.log(chalk.yellow(`\n🎲 使用種子: ${seed}  (可記下此數字以固定聲音風格)`));
    cosyConfig.seed = seed;

    // 讀取 prompt 音頻
    const promptAudioBuffer = await fs.readFile(cosyConfig.promptAudioPath);
    const promptAudioBlob = new Blob([promptAudioBuffer], { type: 'audio/wav' });
    console.log(chalk.green(`✅ 已載入 prompt 音頻 (${(promptAudioBuffer.length / 1024).toFixed(1)} KB)\n`));

    // 解析 EPUB
    console.log('正在解析 EPUB 檔案...');
    const epub = await EPub.createAsync(inputArg);

    for (let i = Math.max(0, startChapter - 1); i < epub.flow.length; i++) {
        const chapter = epub.flow[i];
        console.log(chalk.blue(`\n📖 處理章節 ${i + 1}/${epub.flow.length}: ${chapter.title || '無標題'}`));

        try {
            const htmlContent = await epub.getChapterRawAsync(chapter.id);

            let plainText = convert(htmlContent, { wordwrap: false });
            plainText = plainText.replace(/\[.*?\]/g, '');
            plainText = plainText.replace(/[\u200B-\u200D\uFEFF]/g, '');
            plainText = plainText.replace(/(?<=[\u4e00-\u9fa5])[ \t\r\n]+(?=[\u4e00-\u9fa5])/g, (match) => {
                const newlineCount = (match.match(/\n/g) || []).length;
                return newlineCount >= 2 ? '，\n' : '';
            });

            // 繁體轉簡體（CosyVoice 對簡體支援較好）
            plainText = await converter.convertPromise(plainText);

            if (!plainText.trim()) {
                console.log('  (空章節，跳過)');
                continue;
            }

            const chunks = chunkText(plainText, chunkSize);
            console.log(`  分成 ${chunks.length} 個片段`);

            let chapterAudioIndex = 1;
            for (const chunk of chunks) {
                const outputPath = path.join(
                    outputDir,
                    `${bookName}_chapter_${String(i).padStart(3, '0')}_part_${String(chapterAudioIndex).padStart(3, '0')}.wav`
                );

                process.stdout.write(`  片段 ${chapterAudioIndex}/${chunks.length}: 合成中...`);

                const audioUrl = await synthesizeChunk(client, chunk, promptAudioBlob, cosyConfig);

                // 下載音頻（自動處理 m3u8 串流）
                if (audioUrl.includes('.m3u8')) {
                    await downloadM3u8(audioUrl, outputPath);
                } else {
                    const resp = await fetch(audioUrl, { signal: AbortSignal.timeout(60000) });
                    if (!resp.ok) throw new Error(`下載失敗: HTTP ${resp.status}`);
                    await fs.writeFile(outputPath, Buffer.from(await resp.arrayBuffer()));
                }

                const stat = await fs.stat(outputPath);
                process.stdout.write(` ✅ (${(stat.size / 1024).toFixed(1)} KB)\n`);
                chapterAudioIndex++;
            }

            console.log(chalk.green(`  ✅ 章節 ${i + 1} 完成`));

        } catch (error) {
            console.error(chalk.red(`\n❌ 處理章節 ${chapter.id} 時發生錯誤:`), error.message);

            if (error.cause?.code === 'ECONNREFUSED') {
                console.error(chalk.red('CosyVoice Gradio 伺服器連線失敗，請確認服務是否仍在運行。'));
                process.exit(1);
            }
        }
    }

    console.log(chalk.green('\n🎉 所有章節轉換完畢！'));
}

// ── 將已轉換的音檔同步到 iCloud ────────────────────────────────────────────
async function syncToIcloud(inputArgRaw, syncDest) {
    const inputArg = path.resolve(process.cwd(), inputArgRaw);
    const bookName = path.basename(inputArg, path.extname(inputArg));
    const outputDir = `./output/${bookName}`;

    if (!syncDest) {
        console.error('未提供同步目標路徑！');
        return;
    }

    const bookDestDir = path.join(path.resolve(process.cwd(), syncDest), bookName);
    console.log(`準備同步 ${bookName} 到指定路徑 (${bookDestDir})...`);

    try {
        await fs.mkdir(bookDestDir, { recursive: true });

        try {
            await fs.access(outputDir);
        } catch {
            console.error(`找不到 ${outputDir} 資料夾，請確認是否已經轉換過該書。`);
            return;
        }

        const files = await fs.readdir(outputDir);
        const wavFiles = files.filter(f => f.endsWith('.wav'));

        if (wavFiles.length === 0) {
            console.log('沒有找到可同步的 WAV 檔案。');
        } else {
            console.log(`找到 ${wavFiles.length} 個檔案，同步中...`);
            for (const file of wavFiles) {
                await fs.copyFile(path.join(outputDir, file), path.join(bookDestDir, file));
            }
            console.log(chalk.green(`✅ 已將 ${wavFiles.length} 個音檔同步到:`));
            console.log(`   ${bookDestDir}`);
        }
    } catch (err) {
        console.error('同步失敗，請手動複製:', err.message);
    }
}

// ── 主選單 ──────────────────────────────────────────────────────────────────
async function main() {
    console.clear();
    console.log(
        chalk.green(
            figlet.textSync('Epub TTS', { horizontalLayout: 'full' })
        )
    );
    console.log(chalk.cyan('📖 Epub to TTS Tool  ×  CosyVoice 🗣️\n'));

    const action = await select({
        message: '請選擇你要執行的動作:',
        choices: [
            { name: '1. 轉換 EPUB 為語音檔案 (Convert)', value: 'convert' },
            { name: '2. 將已轉換的音檔同步至 iCloud (Sync)',  value: 'sync' },
            { name: '3. 離開 (Exit)', value: 'exit' }
        ]
    });

    if (action === 'exit') return;

    if (action === 'convert') {
        const inputArg = await input({
            message: '請輸入 epub 檔案路徑 (例如: input/book.epub):',
            validate: v => v ? true : '檔案路徑不能為空！'
        });

        const startChapterStr = await input({
            message: '請輸入起始章節 (預設從第 1 章開始):',
            default: '1',
            validate: v => !isNaN(parseInt(v, 10)) ? true : '請輸入有效的數字！'
        });

        const gradioUrl = await input({
            message: '請輸入 CosyVoice Gradio URL:',
            default: 'http://100.84.200.122:50000',
            validate: v => v ? true : 'URL 不能為空！'
        });

        const promptAudioPath = await input({
            message: '請輸入 prompt 音頻路徑 (≥16kHz WAV):',
            default: './input/prompt.wav',
            validate: v => {
                if (!v) return '路徑不能為空！';
                if (!existsSync(v)) return `找不到檔案: ${v}`;
                return true;
            }
        });

        const promptText = await input({
            message: '請輸入 prompt 音頻對應的文字:',
            default: '我们常常把 1989 年 6 月 3 号晚上到 6 月 4 号早上发生的军事镇压称为「天安门事件」或「天安门屠杀」',
            validate: v => v ? true : '不能為空！'
        });

        const seedStr = await input({
            message: '請輸入隨機種子 (0 = 每次自動隨機):',
            default: '0',
            validate: v => !isNaN(parseInt(v, 10)) ? true : '請輸入有效的數字！'
        });

        const speedStr = await input({
            message: '請輸入語速 (0.5 ~ 2.0，預設 0.9):',
            default: '0.9',
            validate: v => !isNaN(parseFloat(v)) ? true : '請輸入有效的數字！'
        });

        const cosyConfig = {
            gradioUrl,
            promptAudioPath,
            promptText,
            seed: parseInt(seedStr, 10),
            speed: parseFloat(speedStr),
        };

        await convertEpub(inputArg, parseInt(startChapterStr, 10), cosyConfig);

    } else if (action === 'sync') {
        const inputArg = await input({
            message: '請輸入 epub 檔案路徑或書名資料夾名稱:',
            validate: v => v ? true : '路徑或名稱不能為空！'
        });

        const defaultSyncDest = process.platform === 'win32'
            ? 'C:\\'
            : BOOKPLAYER_ICLOUD;

        const syncDest = await input({
            message: '請輸入要同步的目標資料夾路徑:',
            default: defaultSyncDest,
            validate: v => v ? true : '目標路徑不能為空！'
        });

        await syncToIcloud(inputArg, syncDest);
    }
}

main().catch(console.error);
