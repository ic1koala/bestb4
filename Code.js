/**
 * BestB4 - Google Apps Script (GAS) 【金庫・AIプロキシ・通知機能付】
 * 
 * レシピ生成（AI）、在庫管理、および毎日のお知らせ機能を統合したスクリプトです。
 */

// Gemini APIキーをスクリプトプロパティから取得します（なければ下記に記述）
const GEMINI_API_KEY = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY") || "YOUR_API_KEY_HERE";

/**
 * アプリで使用するスプレッドシートを取得します（バインド・スタンドアロン両対応）
 */
function getActiveSpreadsheet() {
  let ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    const ssId = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
    if (ssId) {
      try {
        ss = SpreadsheetApp.openById(ssId);
      } catch (err) {
        console.error("Failed to open spreadsheet by SPREADSHEET_ID: " + err.toString());
      }
    }
  }
  if (!ss) {
    throw new Error("スプレッドシートが見つかりません。コンテナバインドスクリプトにするか、スクリプトプロパティに SPREADSHEET_ID を設定してください。");
  }
  return ss;
} 

/**
 * 毎日決まった時間に実行する通知関数
 * GASエディタの「トリガー（時計アイコン）」から、1日1回実行するように設定してください。
 */
function dailyReminder() {
  const ss = getActiveSpreadsheet();
  const sheet = ss.getSheetByName("在庫リスト") || ss.getSheets()[0];
  const rows = sheet.getDataRange().getValues();
  const today = new Date();
  today.setHours(0,0,0,0);
  
  // 期限2日前の日付を計算
  const targetDate = new Date(today);
  targetDate.setDate(today.getDate() + 2); 
  const targetDateStr = Utilities.formatDate(targetDate, "JST", "yyyy-MM-dd");
  
  let userReminders = {}; // { email: [itemName, ...] }
  
  for (let i = 1; i < rows.length; i++) {
    const email = rows[i][1];
    const itemName = rows[i][2];
    const expDateCandidate = rows[i][5];
    const archived = rows[i][6];
    
    if (archived) continue;
    
    let expStr = "";
    if (expDateCandidate instanceof Date) {
      expStr = Utilities.formatDate(expDateCandidate, "JST", "yyyy-MM-dd");
    } else {
      expStr = expDateCandidate.toString();
    }
    
    if (expStr === targetDateStr) {
      if (!userReminders[email]) userReminders[email] = [];
      userReminders[email].push(itemName);
    }
  }
  
  // 各ユーザーにメール送信
  for (let email in userReminders) {
    const items = userReminders[email];
    MailApp.sendEmail({
      to: email,
      subject: "【BestB4】賞味期限2日前のお知らせ",
      body: "BestB4をご利用いただきありがとうございます。\n\n以下の食材の賞味期限があと2日です。お早めに！\n\n・" + items.join("\n・") + "\n\nアプリを開いてレシピをチェックしましょう。"
    });
  }
}

function doGet(e) {
  const action = e.parameter.action;

  if (action === "getApiKey") {
    return ContentService.createTextOutput(JSON.stringify({ apiKey: GEMINI_API_KEY }))
                         .setMimeType(ContentService.MimeType.JSON);
  }

  if (action === "getRecipes") {
    return generateRecipesByAI(e.parameter.ingredients);
  }
  
  try {
    var ss    = getActiveSpreadsheet();
    var sheet = ss.getSheetByName("在庫リスト") || ss.getSheets()[0];
    var rows  = sheet.getDataRange().getValues();
    var email = e.parameter.email;
    var results = [];
    for (var i = 1; i < rows.length; i++) {
      if (rows[i][1] !== email) continue;
      results.push({
        id: i + 1,
        name: rows[i][2],
        cat: rows[i][3],
        qty: rows[i][4],
        exp: rows[i][5] instanceof Date ? Utilities.formatDate(rows[i][5], "JST", "yyyy-MM-dd") : rows[i][5],
        archivedAt: rows[i][6] instanceof Date ? rows[i][6].toISOString() : rows[i][6]
      });
    }
    return ContentService.createTextOutput(JSON.stringify(results)).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ error: err.toString() })).setMimeType(ContentService.MimeType.JSON);
  }
}

function generateRecipesByAI(ingredients) {
  const prompt = "あなたはプロの料理研究家です。以下の食材をベースに「今すぐネットで人気のレシピ」を検索・整理し、3〜5個提案してください。\n食材: " + ingredients + "\n\n必ず以下のJSON配列フォーマットのみを出力してください。\n[{\"title\": \"料理名\", \"desc\": \"要約\", \"source\": \"検索ソース\", \"url\": \"リンクURL\", \"ing\": \"活用食材\"}]";
  
  // REST APIの正しいキャメルケース形式 (googleSearchRetrieval) を使用
  const payloadWithSearch = {
    contents: [{ parts: [{ text: prompt }] }],
    tools: [{ googleSearchRetrieval: { dynamicRetrievalConfig: { mode: "MODE_DYNAMIC", dynamicThreshold: 0.3 } } }],
    generationConfig: { responseMimeType: "application/json" }
  };
  
  const payloadWithoutSearch = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json" }
  };

  // 2026年現在で有効な最新のGeminiモデルリスト（旧1.5系はサービス終了したため、2.5系/2.0系/3.1系を使用します）
  const models = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite', 'gemini-3.1-flash-lite'];
  const history = [];
  let searchSupported = true; // 無料版キー等の制約でGoogle検索ツールが使えない場合に自動でfalse化します

  for (let i = 0; i < models.length; i++) {
    const m = models[i];
    // API制限（15RPM）を考慮し、最も成功率の高い設定をフォールバックとして試行します
    const configs = [
      { v: 'v1beta', j: true, s: true }, // JSONあり、ウェブ検索あり
      { v: 'v1beta', j: true, s: false },// JSONあり、ウェブ検索なし
      { v: 'v1', j: false, s: false }    // JSONなし、ウェブ検索なし（最も安定した標準仕様）
    ];

    for (let k = 0; k < configs.length; k++) {
      const conf = configs[k];
      
      // すでに検索ツールが使えないと判明している場合は、検索付き設定の試行をスキップします
      if (conf.s && !searchSupported) {
        continue;
      }

      const payload = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: conf.j ? { responseMimeType: "application/json" } : {}
      };
      if (conf.s) {
        payload.tools = [{ googleSearchRetrieval: { dynamicRetrievalConfig: { mode: "MODE_DYNAMIC", dynamicThreshold: 0.3 } } }];
      }

      const url = "https://generativelanguage.googleapis.com/" + conf.v + "/models/" + m + ":generateContent?key=" + GEMINI_API_KEY;
      const options = { 
        method: "post", 
        contentType: "application/json", 
        payload: JSON.stringify(payload), 
        muteHttpExceptions: true 
      };
      
      try {
        const response = UrlFetchApp.fetch(url, options);
        const code = response.getResponseCode();
        const text = response.getContentText();
        
        if (code === 200) {
          return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
        }
        
        // 検索ツール（googleSearchRetrieval）に対応していないキー（無料版キー等）の場合、エラーコード400/403、
        // または特定のエラー文言を検知して自動的にウェブ検索付き試行を無効化します（無駄なAPI呼び出しを抑止）
        if (conf.s && (code === 400 || code === 403 || text.includes("tool") || text.includes("search") || text.includes("permission") || text.includes("not allowed") || text.includes("not supported"))) {
          searchSupported = false;
          console.warn("Search grounding is not supported by this API key. Disabling search grounding configs.");
        }
        
        const errStr = m + "(" + conf.v + ",j:" + conf.j + ",s:" + conf.s + "): " + code;
        if (code !== 404) {
          history.push(errStr + " " + text.substring(0, 50));
        }
        
        if (text.includes("API key not valid")) {
           return ContentService.createTextOutput(JSON.stringify({ error: "ERR-GAS-API-KEY: APIキーが無効です。" })).setMimeType(ContentService.MimeType.JSON);
        }
      } catch (err) {
        history.push(m + " Error: " + err.toString());
      }
    }
  }
  
  return ContentService.createTextOutput(JSON.stringify({ 
    error: "AI全試行失敗", 
    log: history.join(" | ") 
  })).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    var ss = getActiveSpreadsheet();
    var sheet = ss.getSheetByName("在庫リスト") || ss.getSheets()[0];
    var data = JSON.parse(e.postData.contents);
    var action = data.action;
    var email  = data.email;
    if (action === "add") {
      sheet.appendRow([new Date(), email, data.name, data.cat || "その他", data.qty || 1, data.exp || "", ""]);
    } else if (action === "update") {
      var id = parseInt(data.id);
      if (id) {
        if (data.name !== undefined) sheet.getRange(id, 3).setValue(data.name);
        if (data.cat  !== undefined) sheet.getRange(id, 4).setValue(data.cat);
        if (data.qty  !== undefined) sheet.getRange(id, 5).setValue(data.qty);
        if (data.exp  !== undefined) sheet.getRange(id, 6).setValue(data.exp);
        if (data.archivedAt !== undefined) sheet.getRange(id, 7).setValue(data.archivedAt);
      }
    }
    return ContentService.createTextOutput(JSON.stringify({ status: "success" })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: err.toString() })).setMimeType(ContentService.MimeType.JSON);
  }
}
