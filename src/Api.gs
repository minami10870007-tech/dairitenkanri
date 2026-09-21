/**
 * 外部（Netlify に置いた静的フロント）から呼ぶための JSON API。
 *
 * ・POST 1本だけで全機能を扱う（GET は Code.gs 側の画面表示に使うため）
 * ・Content-Type: text/plain で送ってもらう＝CORS プリフライトが飛ばないので
 *   Apps Script 側で OPTIONS を処理できない問題を回避できる
 * ・合言葉（トークン）が一致しないリクエストは拒否する
 */

/** トークンを保存するスクリプトプロパティのキー */
const API_TOKEN_KEY = 'API_TOKEN';

/**
 * 合言葉を発行する。Apps Script エディタから手動で1回実行する。
 * 表示された文字列を Netlify 側の画面に入力する。
 */
function issueApiToken() {
  const token = Utilities.getUuid().replace(/-/g, '').slice(0, 16);
  PropertiesService.getScriptProperties().setProperty(API_TOKEN_KEY, token);

  const ui = getUi_();
  if (ui) {
    ui.alert('合言葉を発行しました', token + '\n\nこの文字列を Netlify の画面で入力してください。\n（再発行すると前の合言葉は使えなくなります）', ui.ButtonSet.OK);
  }
  Logger.log('API_TOKEN: %s', token);
  return token;
}

/** 現在の合言葉を確認する（忘れたとき用） */
function showApiToken() {
  const token = PropertiesService.getScriptProperties().getProperty(API_TOKEN_KEY);
  const ui = getUi_();
  const message = token ? token : '未発行です。issueApiToken を実行してください。';
  if (ui) {
    ui.alert('現在の合言葉', message, ui.ButtonSet.OK);
  }
  return token;
}

/** API の入り口 */
function doPost(e) {
  try {
    const request = parseRequest_(e);
    verifyToken_(request.token);
    return json_({ ok: true, data: handleAction_(request) });
  } catch (error) {
    return json_({ ok: false, error: error && error.message ? error.message : String(error) });
  }
}

/** リクエスト本文を JSON として読む */
function parseRequest_(e) {
  const body = e && e.postData && e.postData.contents ? e.postData.contents : '';
  if (!body) throw new Error('リクエストが空です。');
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error('リクエストの形式が不正です（JSON で送ってください）。');
  }
}

/** 合言葉を検証する。未発行なら誰も通さない（安全側に倒す） */
function verifyToken_(token) {
  const expected = PropertiesService.getScriptProperties().getProperty(API_TOKEN_KEY);
  if (!expected) {
    throw new Error('合言葉が未発行です。Apps Script で issueApiToken を実行してください。');
  }
  if (String(token || '') !== expected) {
    throw new Error('合言葉が違います。');
  }
}

/** action ごとに処理を振り分ける */
function handleAction_(request) {
  switch (request.action) {
    case 'bootstrap': // 初回表示用：3つまとめて返して往復を減らす
      return {
        config: { statuses: STATUSES },
        list: listReferrers('', ''),
        summary: getSummary()
      };
    case 'config':
      return { statuses: STATUSES };
    case 'list':
      return listReferrers(request.query, request.status);
    case 'add':
      return addReferrer(request.form);
    case 'update':
      return updateReferrer(request.id, request.form);
    case 'updateStatus':
      return updateStatus(request.id, request.status);
    case 'delete':
      return deleteReferrer(request.id);
    case 'summary':
      return getSummary();
    default:
      throw new Error('不明な action です: ' + request.action);
  }
}

/** JSON を返す */
function json_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
