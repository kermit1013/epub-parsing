import { EPub } from 'epub2';
import { convert } from 'html-to-text';
import fs from 'fs/promises';
import { createWriteStream, readFileSync } from 'fs';
import path from 'path';
import OpenCC from 'opencc';

// 讀取命令列參數，例如：node index.js input/the-seven-good-years.epub
const inputArg = process.argv[2] || './input.epub';
const startChapter = parseInt(process.argv[3] || '1', 10); // 可以傳入起始章節
const bookName = path.basename(inputArg, path.extname(inputArg)); // 萃取出 the-seven-good-years

// BookPlayer 的 iCloud 路徑 (自動同步到 iOS)
const BOOKPLAYER_ICLOUD = `${process.env.HOME}/Library/Mobile Documents/iCloud~com~tortugapower~audiobookplayer/Documents`;

// --- 設定區塊 ---
const CONFIG = {
    epubPath: inputArg,
    outputDir: `./output/${bookName}`, // 每本書有自己的資料夾
    ttsUrl: 'http://127.0.0.1:8001/voices/1773143034_338e8c37/tts',
    chunkSize: 200 // 縮小文字段落大小，避免本地 TTS 運算太久導致逾時
};

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

// 主程式
async function main() {
    await fs.mkdir(CONFIG.outputDir, { recursive: true });
    
    console.log('正在解析 EPUB 檔案...');
    const epub = await EPub.createAsync(CONFIG.epubPath);

    for (let i = Math.max(0, startChapter - 1); i < epub.flow.length; i++) {
        const chapter = epub.flow[i];
        console.log(`處理章節 ${i + 1}/${epub.flow.length}: ${chapter.title || '無標題'}`);

        try {
            const htmlContent = await epub.getChapterRawAsync(chapter.id);
            
            // 提取純文字並清洗
            let plainText = convert(htmlContent, { wordwrap: false });
            plainText = plainText.replace(/\[.*?\]/g, ''); // 移除可能的圖片標籤或註腳
            
            // 清理隱形字元與意外的分行 (解決 0.5~1 秒的莫名停頓問題)
            // HTML 排版常會將一個詞語切開 (例如 "明\n白")，導致 TTS 產生不連貫的停頓
            plainText = plainText.replace(/[\u200B-\u200D\uFEFF]/g, '');
            plainText = plainText.replace(/(?<=[\u4e00-\u9fa5])[ \t\r\n]+(?=[\u4e00-\u9fa5])/g, (match) => {
                const newlineCount = (match.match(/\n/g) || []).length;
                // 如果是段落 (2個以上換行)，補上逗號引導自然停頓並保留換行以利分段
                return newlineCount >= 2 ? '，\n' : ''; 
            });

            // 將內文進行繁體轉簡體轉換 (因為新 TTS 模型讀簡體效果較佳)
            plainText = await converter.convertPromise(plainText);
            
            if (!plainText.trim()) continue;

            const chunks = chunkText(plainText, CONFIG.chunkSize);
            
            // 將章節轉換為音檔
            let chapterAudioIndex = 1;
            for (const chunk of chunks) {
                const outputPath = path.join(CONFIG.outputDir, `${bookName}_chapter_${String(i).padStart(3, '0')}_part_${String(chapterAudioIndex).padStart(3, '0')}.wav`);
                
                const formData = new FormData();
                formData.append('text', chunk);

                // 設定較長的 Timeout (10分鐘) 防範超時錯喔
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
            console.error(`處理章節 ${chapter.id} 時發生錯誤:`, error);
        }
    }

    console.log('所有章節轉換完畢。');

    // 自動同步到 BookPlayer iCloud 資料夾
    const bookDestDir = path.join(BOOKPLAYER_ICLOUD, bookName);
    try {
        await fs.mkdir(bookDestDir, { recursive: true });
        const files = await fs.readdir(CONFIG.outputDir);
        const wavFiles = files.filter(f => f.endsWith('.wav'));
        if (wavFiles.length === 0) {
            console.log('沒有找到可同步的 WAV 檔案。');
        } else {
            for (const file of wavFiles) {
                await fs.copyFile(path.join(CONFIG.outputDir, file), path.join(bookDestDir, file));
            }
            console.log(`✅ 已將 ${wavFiles.length} 個音檔同步到 BookPlayer iCloud:`);
            console.log(`   ${bookDestDir}`);
            console.log('📱 請稍候片刻， iOS 的 BookPlayer 會自動取得此書籍。');
        }
    } catch (err) {
        console.error('同步到 BookPlayer 失敗，請手動複製:', err.message);
    }
}

main().catch(console.error);
