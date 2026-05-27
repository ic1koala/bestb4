/**
 * BestB4 - Google Apps Script (GAS) 【金庫・AIプロキシ・通知・多機能バックアップ機能付】
 * 
 * レシピ生成（AI）、在庫管理、買い物リスト・定番品バックアップ、および毎日のお知らせ機能を統合したスクリプトです。
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
 * 指定されたシートを取得し、なければ新規作成します。（自立復元型）
 */
function getOrCreateSheet(ss, name) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (name === "在庫リスト") {
      sheet.appendRow(["タイムスタンプ", "メールアドレス", "商品名", "カテゴリー", "数量", "賞味期限", "消費日", "ユニークID"]);
    } else if (name === "買い物リスト") {
      sheet.appendRow(["タイムスタンプ", "メールアドレス", "ID", "商品名", "数量", "チェック済"]);
    } else if (name === "定番品リスト") {
      sheet.appendRow(["タイムスタンプ", "メールアドレス", "ID", "商品名"]);
    }
  }
  return sheet;
}

/**
 * 不要になった古いトリガー（関数が存在しない、または使用していないトリガー）をクリーンアップします。
 */
function deleteOrphanedTriggers() {
  try {
    const triggers = ScriptApp.getProjectTriggers();
    // 現在稼働を許可する正規のトリガー関数名のみ
    const allowedFunctions = ["dailyReminder"];
    
    for (let i = 0; i < triggers.length; i++) {
      const trigger = triggers[i];
      const funcName = trigger.getHandlerFunction();
      if (!allowedFunctions.includes(funcName)) {
        console.log("Deleting orphaned or old trigger: " + funcName);
        ScriptApp.deleteTrigger(trigger);
      }
    }
  } catch (err) {
    console.error("Failed to delete orphaned triggers: " + err.toString());
  }
}

/**
 * 毎日決まった時間に実行する通知関数
 * GASエディタの「トリガー（時計アイコン）」から、1日1回実行するように設定してください。
 */
function dailyReminder() {
  // 古い不要トリガーを自動クリーンアップ
  deleteOrphanedTriggers();

  const ss = getActiveSpreadsheet();
  const sheet = getOrCreateSheet(ss, "在庫リスト");
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
      expStr = expDateCandidate ? expDateCandidate.toString() : "";
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
  // 古い不要トリガーを自動クリーンアップ
  deleteOrphanedTriggers();

  const action = e.parameter.action;

  if (action === "getApiKey") {
    return ContentService.createTextOutput(JSON.stringify({ apiKey: GEMINI_API_KEY }))
                         .setMimeType(ContentService.MimeType.JSON);
  }

  if (action === "getRecipes") {
    return generateRecipesByAI(e.parameter.ingredients);
  }

  if (action === "getBackupData") {
    try {
      var ss = getActiveSpreadsheet();
      var email = e.parameter.email;
      
      // 1. 買い物リストの読み込み
      var shopSheet = getOrCreateSheet(ss, "買い物リスト");
      var shopRows = shopSheet.getDataRange().getValues();
      var shoppingList = [];
      for (var i = 1; i < shopRows.length; i++) {
        if (shopRows[i][1] === email) {
          shoppingList.push({
            id: String(shopRows[i][2]),
            name: String(shopRows[i][3]),
            qty: parseInt(shopRows[i][4]) || 1,
            checked: shopRows[i][5] === true || String(shopRows[i][5]).toLowerCase() === "true"
          });
        }
      }
      
      // 2. 定番品リストの読み込み
      var alwaysSheet = getOrCreateSheet(ss, "定番品リスト");
      var alwaysRows = alwaysSheet.getDataRange().getValues();
      var alwaysBuyList = [];
      for (var i = 1; i < alwaysRows.length; i++) {
        if (alwaysRows[i][1] === email) {
          alwaysBuyList.push({
            id: String(alwaysRows[i][2]),
            name: String(alwaysRows[i][3])
          });
        }
      }
      
      return ContentService.createTextOutput(JSON.stringify({
        shoppingList: shoppingList,
        alwaysBuyList: alwaysBuyList
      })).setMimeType(ContentService.MimeType.JSON);
    } catch (err) {
      return ContentService.createTextOutput(JSON.stringify({ error: err.toString() })).setMimeType(ContentService.MimeType.JSON);
    }
  }
  
  try {
    var ss    = getActiveSpreadsheet();
    var sheet = getOrCreateSheet(ss, "在庫リスト");
    var rows  = sheet.getDataRange().getValues();
    var email = e.parameter.email;
    var results = [];
    for (var i = 1; i < rows.length; i++) {
      if (rows[i][1] !== email) continue;
      // 8列目にユニークIDがあればそれを使用し、なければ行番号(i + 1)をフォールバックIDとする
      var uniqueId = (rows[i][7] && String(rows[i][7]).trim()) ? String(rows[i][7]).trim() : String(i + 1);
      results.push({
        id: uniqueId,
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
  const prompt = "あなたは食材消費とフードロス削減の専門家です。期限が近い以下の食材を賢く消費、または長持ちさせるためのTIPS（超簡単アレンジや保存ハック）を3〜5個提案してください。\n食材: " + ingredients + "\n\n必ず以下のJSON配列フォーマットのみを出力してください。マークダウンの```json等の枠線は含めず、純粋なJSON配列のみを返してください。\n[{\"title\": \"TIPSのタイトル\", \"type\": \"調理 | 保存\", \"desc\": \"具体的なアクション・コツ（家にある調味料で2分で作れる一品や、長持ちさせる冷凍保存法など、2行以内で記述）\", \"ing\": \"対象食材\"}]";
  
  const payloadWithSearch = {
    contents: [{ parts: [{ text: prompt }] }],
    tools: [{ googleSearchRetrieval: { dynamicRetrievalConfig: { mode: "MODE_DYNAMIC", dynamicThreshold: 0.3 } } }],
    generationConfig: { responseMimeType: "application/json" }
  };

  const models = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite', 'gemini-3.1-flash-lite'];
  const history = [];
  let searchSupported = true;

  for (let i = 0; i < models.length; i++) {
    const m = models[i];
    const configs = [
      { v: 'v1beta', j: true, s: true },
      { v: 'v1beta', j: true, s: false },
      { v: 'v1', j: false, s: false }
    ];

    for (let k = 0; k < configs.length; k++) {
      const conf = configs[k];
      
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
        
        if (conf.s && (code === 400 || code === 403 || text.includes("tool") || text.includes("search") || text.includes("permission") || text.includes("not allowed") || text.includes("not supported"))) {
          searchSupported = false;
          console.warn("Search grounding is not supported by this API key. Disabling search grounding.");
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
    var data = JSON.parse(e.postData.contents);
    var action = data.action;
    var email  = data.email;
    
    if (action === "add") {
      var sheet = getOrCreateSheet(ss, "在庫リスト");
      var archivedAtVal = "";
      if (data.archivedAt) {
        var parsedDate = new Date(data.archivedAt);
        if (!isNaN(parsedDate.getTime())) {
          archivedAtVal = parsedDate;
        } else {
          archivedAtVal = data.archivedAt;
        }
      }
      // 8列目（ユニークID）も一緒にアペンドする
      sheet.appendRow([new Date(), email, data.name, data.cat || "その他", data.qty || 1, data.exp || "", archivedAtVal, data.id || ""]);
      
    } else if (action === "update") {
      var sheet = getOrCreateSheet(ss, "在庫リスト");
      var idStr = String(data.id).trim();
      var rowIndex = -1;
      
      // 1. ユニークIDが一致する行を8列目から探す
      if (idStr) {
        var lastRow = sheet.getLastRow();
        if (lastRow > 1) {
          var ids = sheet.getRange(2, 8, lastRow - 1, 1).getValues();
          for (var r = 0; r < ids.length; r++) {
            if (String(ids[r][0]).trim() === idStr) {
              rowIndex = r + 2;
              break;
            }
          }
        }
      }
      
      // 2. 見つからない場合は従来の「行番号」としてフォールバック処理を行う
      if (rowIndex === -1) {
        var numericId = parseInt(data.id);
        if (!isNaN(numericId) && numericId > 0 && numericId <= sheet.getLastRow()) {
          rowIndex = numericId;
        }
      }
      
      if (rowIndex !== -1) {
        if (data.name !== undefined) sheet.getRange(rowIndex, 3).setValue(data.name);
        if (data.cat  !== undefined) sheet.getRange(rowIndex, 4).setValue(data.cat);
        if (data.qty  !== undefined) sheet.getRange(rowIndex, 5).setValue(data.qty);
        if (data.exp  !== undefined) sheet.getRange(rowIndex, 6).setValue(data.exp);
        if (data.archivedAt !== undefined) sheet.getRange(rowIndex, 7).setValue(data.archivedAt);
        
        // 既存の古いデータでユニークIDが入っていなかった場合は自動で移行(Migration)
        if (sheet.getRange(rowIndex, 8).getValue() === "") {
          sheet.getRange(rowIndex, 8).setValue(idStr);
        }
      }
      
    } else if (action === "syncShopping") {
      var shopSheet = getOrCreateSheet(ss, "買い物リスト");
      var shopRows = shopSheet.getDataRange().getValues();
      
      // 既存のこのメールアドレスの買い物リストデータを全クリア
      for (var i = shopRows.length - 1; i >= 1; i--) {
        if (shopRows[i][1] === email) {
          shopSheet.deleteRow(i + 1);
        }
      }
      
      // 新しい買い物リストを追加
      var list = data.list || [];
      for (var j = 0; j < list.length; j++) {
        var item = list[j];
        shopSheet.appendRow([new Date(), email, item.id, item.name, item.qty || 1, item.checked || false]);
      }
      
    } else if (action === "syncAlwaysBuy") {
      var alwaysSheet = getOrCreateSheet(ss, "定番品リスト");
      var alwaysRows = alwaysSheet.getDataRange().getValues();
      
      // 既存のこのメールアドレスの定番品データを全クリア
      for (var i = alwaysRows.length - 1; i >= 1; i--) {
        if (alwaysRows[i][1] === email) {
          alwaysSheet.deleteRow(i + 1);
        }
      }
      
      // 新しい定番品リストを追加
      var list = data.list || [];
      for (var j = 0; j < list.length; j++) {
        var item = list[j];
        alwaysSheet.appendRow([new Date(), email, item.id, item.name]);
      }
    } else if (action === "clearHistory") {
      var sheet = getOrCreateSheet(ss, "在庫リスト");
      var rows = sheet.getDataRange().getValues();
      for (var i = rows.length - 1; i >= 1; i--) {
        if (rows[i][1] === email && rows[i][6] !== "") {
          sheet.deleteRow(i + 1);
        }
      }
    }
    
    return ContentService.createTextOutput(JSON.stringify({ status: "success" })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: err.toString() })).setMimeType(ContentService.MimeType.JSON);
  }
}
