#!/usr/bin/env node
import { EPub } from 'epub2';
import { convert } from 'html-to-text';
import fs from 'fs/promises';
import { createWriteStream, readFileSync } from 'fs';
import path from 'path';
import OpenCC from 'opencc';
import { select, input } from '@inquirer/prompts';
import chalk from 'chalk';
import figlet from 'figlet';

// 隱藏來自 epub2 舊版 url.parse 引發的 DeprecationWarning 警告
process.removeAllListeners('warning');

// BookPlayer 的 iCloud 路徑 (自動同步到 iOS)
const BOOKPLAYER_ICLOUD = `${process.env.HOME}/Library/Mobile Documents/iCloud~com~tortugapower~audiobookplayer/Documents`;

// 初始化 OpenCC (繁體轉簡體)
const converter = new OpenCC('t2s.json');

// 文本分段邏輯 (按標點符號與長度限制分割)
function chunkText(text, maxLength) {
    const chunks = [];
    let currentChunk = '';
    
    // 以常見句讀作為分割點
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

// 將 EPUB 轉換為純文字並呼叫 TTS 轉換成語音
async function convertEpub(inputArgRaw, startChapter, ttsUrl) {
    const inputArg = path.resolve(process.cwd(), inputArgRaw);
    const bookName = path.basename(inputArg, path.extname(inputArg));
    const CONFIG = {
        epubPath: inputArg,
        outputDir: `./output/${bookName}`,
        ttsUrl: ttsUrl || 'http://127.0.0.1:8001/voices/1773143034_338e8c37/tts',
        chunkSize: 200
    };

    await fs.mkdir(CONFIG.outputDir, { recursive: true });
    
    console.log('正在解析 EPUB 檔案...');
    const epub = await EPub.createAsync(CONFIG.epubPath);

    for (let i = Math.max(0, startChapter - 1); i < epub.flow.length; i++) {
        const chapter = epub.flow[i];
        console.log(`處理章節 ${i + 1}/${epub.flow.length}: ${chapter.title || '無標題'}`);

        try {
            const htmlContent = await epub.getChapterRawAsync(chapter.id);
            
            let plainText = convert(htmlContent, { wordwrap: false });
            plainText = plainText.replace(/\[.*?\]/g, '');
            
            plainText = plainText.replace(/[\u200B-\u200D\uFEFF]/g, '');
            plainText = plainText.replace(/(?<=[\u4e00-\u9fa5])[ \t\r\n]+(?=[\u4e00-\u9fa5])/g, (match) => {
                const newlineCount = (match.match(/\n/g) || []).length;
                return newlineCount >= 2 ? '，\n' : ''; 
            });

            plainText = await converter.convertPromise(plainText);
            
            if (!plainText.trim()) continue;

            const chunks = chunkText(plainText, CONFIG.chunkSize);
            
            let chapterAudioIndex = 1;
            for (const chunk of chunks) {
                const outputPath = path.join(CONFIG.outputDir, `${bookName}_chapter_${String(i).padStart(3, '0')}_part_${String(chapterAudioIndex).padStart(3, '0')}.wav`);
                
                const formData = new FormData();
                formData.append('text', chunk);

                const response = await fetch(CONFIG.ttsUrl, {
                    method: 'POST',
                    body: formData,
                    signal: AbortSignal.timeout(600000)
                });
                
                if (!response.ok) {
                    throw new Error(`TTS API failed with status ${response.status}: ${await response.text()}`);
                }
                
                const buffer = await response.arrayBuffer();
                await fs.writeFile(outputPath, Buffer.from(buffer));
                
                chapterAudioIndex++;
            }
            console.log(`章節 ${i + 1} 轉換完成。`);
            
        } catch (error) {
            console.error(`❌ 處理章節 ${chapter.id} 時發生錯誤:`, error);
            
            // 如果是無法連線到 TTS 伺服器 (ECONNREFUSED)，代表服務沒開或掛了，直接中斷轉換
            if (error.cause && error.cause.code === 'ECONNREFUSED') {
                console.error('TTS 伺服器連線失敗 (ECONNREFUSED)，請確認本地 TTS 服務是否已啟動。');
                console.error('即將中斷程式執行...');
                process.exit(1); 
            }
        }
    }

    console.log('所有章節轉換完畢。');
}

// 將 output 裡頭已經轉好的音檔複製到 iCloud 供 BookPlayer 讀取
async function syncToIcloud(inputArgRaw, syncDest) {
    const inputArg = path.resolve(process.cwd(), inputArgRaw);
    const bookName = path.basename(inputArg, path.extname(inputArg));
    const outputDir = `./output/${bookName}`;
    
    // 如果使用者沒有輸入路徑 (undefined)，會報錯，所以需要 fallback
    if (!syncDest) {
         console.error('未提供同步目標路徑！');
         return;
    }
    
    // 將最後的書名資料夾加上去
    const bookDestDir = path.join(path.resolve(process.cwd(), syncDest), bookName);
    
    console.log(`準備同步 ${bookName} 到指定路徑 (${bookDestDir})...`);
    
    try {
        await fs.mkdir(bookDestDir, { recursive: true });
        
        // 確保 output 資料夾存在
        try {
            await fs.access(outputDir);
        } catch (err) {
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
            console.log(`✅ 已將 ${wavFiles.length} 個音檔同步到:`);
            console.log(`   ${bookDestDir}`);
        }
    } catch (err) {
        console.error('同步失敗，請手動複製:', err.message);
    }
}

async function main() {
    console.clear();
    console.log(
        chalk.green(
            figlet.textSync('Epub TTS', { horizontalLayout: 'full' })
        )
    );
    console.log(chalk.cyan('📖 Epub to TTS Tool 🗣️\n'));

    const action = await select({
        message: '請選擇你要執行的動作:',
        choices: [
            { name: '1. 轉換 EPUB 為語音標案 (Convert)', value: 'convert' },
            { name: '2. 將已轉換的音檔同步至 iCloud (Sync)', value: 'sync' },
            { name: '3. 離開 (Exit)', value: 'exit' }
        ]
    });

    if (action === 'exit') {
        return;
    }

    if (action === 'convert') {
        const inputArg = await input({
            message: '請輸入 epub 檔案路徑 (例如: input/book.epub):',
            validate: value => value ? true : '檔案路徑不能為空！'
        });
        
        const startChapter = await input({
            message: '請輸入起始章節 (預設從第 1 章開始):',
            default: '1',
            validate: value => !isNaN(parseInt(value, 10)) ? true : '請輸入有效的數字！'
        });

        const ttsUrl = await input({
            message: '請輸入 TTS API URL:',
            default: 'http://127.0.0.1:8001/voices/1773143034_338e8c37/tts',
            validate: value => value ? true : 'URL 不能為空！'
        });
        
        await convertEpub(inputArg, parseInt(startChapter, 10), ttsUrl);
    } else if (action === 'sync') {
        const inputArg = await input({
            message: '請輸入 epub 檔案路徑或書名資料夾名稱:',
            validate: value => value ? true : '路徑或名稱不能為空！'
        });
        
        const defaultSyncDest = process.platform === 'win32'
            ? 'C:\\' // Windows 預設隨便給一個 C 槽，或是可以留空
            : `${process.env.HOME}/Library/Mobile Documents/iCloud~com~tortugapower~audiobookplayer/Documents`;

        const syncDest = await input({
            message: '請輸入要同步的目標資料夾路徑 (例如 iCloud 或隨身碟):',
            default: defaultSyncDest,
            validate: value => value ? true : '目標路徑不能為空！'
        });
        
        await syncToIcloud(inputArg, syncDest);
    }
}

main().catch(console.error);
