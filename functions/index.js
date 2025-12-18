/**
 * functions/index.js
 * Realtime Database (/chat) にユーザー投稿が来たら Gemini で自動返信して /chat に書き戻す
 */

const admin = require("firebase-admin");
admin.initializeApp();

const { onValueCreated } = require("firebase-functions/v2/database");
const { logger } = require("firebase-functions");
const { defineSecret } = require("firebase-functions/params");

// Firebase Secret Manager に入れたキーを参照（直貼りしない）
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

// ✅ ここは安定して動いたリージョンに固定（あなたの環境では us-central1 で作成成功してた）
const REGION = "us-central1";

// ✅ 使うモデル（まずは速い flash でOK。もっと賢くしたければ gemini-2.0-pro 等に差し替え）
const GEMINI_MODEL = "gemini-2.0-pro";

// ✅ 会話履歴をどれだけ読むか（重すぎない範囲で 20〜40 がおすすめ）
const HISTORY_LIMIT = 30;

exports.autoReplyWithGemini = onValueCreated(
  {
    ref: "/chat/{pushId}",
    region: REGION,
    secrets: [GEMINI_API_KEY],
  },
  async (event) => {
    try {
      const msg = event.data.val();
      if (!msg) return;

      // 無限ループ防止：AIの投稿は無視
      if (msg.isAI === true || msg.uname === "AI") return;

      const userText = String(msg.text || "").trim();
      if (!userText) return;

      // ① 直近の会話履歴を読む（createdAt が無い投稿も混ざる可能性があるのでフォールバックあり）
      const snap = await admin
        .database()
        .ref("chat")
        .orderByChild("createdAt")
        .limitToLast(HISTORY_LIMIT)
        .once("value");

      const history = [];
      snap.forEach((child) => {
        const m = child.val();
        if (!m || !m.text) return;
        const role = m.isAI ? "AI" : "USER";
        const uname = m.uname ? String(m.uname) : role;
        const text = String(m.text).replace(/\s+/g, " ").trim();
        history.push(`${role}(${uname}): ${text}`);
      });

      const historyText = history.join("\n");

      // ② 「微妙回答」を防ぐための強めプロンプト（質問返し地獄を禁止）
      const system = `
あなたは日本語の「事業企画・キャリアの壁打ちメンター」です。

【絶対ルール】
- まず結論 → 次に具体策 → 最後に確認質問は最大1つ
- 同じ質問を繰り返さない（直前で聞いたことは聞かない）
- 抽象論だけで終わらず、「今日/今週できる行動」を出す
- 出力は短くてもいいが、中身は具体的に（例・テンプレ・手順歓迎）
- 口調はフレンドリーだが無駄に持ち上げない
- 3〜4行ごとに必ず改行し、箇条書きを多用する（1文を長くしない）
【出力フォーマット】
### 結論
（1〜2行）

### 具体アクション
- 今日：
- 今週：
- 今月：

### 1つだけ確認したいこと
（質問は1つ）
`.trim();

      const prompt = `
${system}

【会話履歴（直近）】
${historyText}

【ユーザーの最新発言】
${userText}
`.trim();

      // ③ Gemini API 呼び出し
      const apiKey = GEMINI_API_KEY.value();
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.4,      // ブレを抑えて実務寄り
            maxOutputTokens: 700,  // ちゃんと提案が書ける長さ
          },
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        logger.error("Gemini API error", res.status, errText);
        return;
      }

      const json = await res.json();
      const reply =
        json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ||
        "ごめん、うまく返せなかった…！もう一回だけ言い方変えてくれる？";

      // ④ AI返信を書き込む（フロントが勝手に表示する）
      await admin.database().ref("chat").push({
        uname: "AI",
        text: reply,
        isAI: true,
        createdAt: Date.now(),
      });

      logger.info("Replied with AI message");
    } catch (e) {
      logger.error("autoReplyWithGemini failed", e);
    }
  }
);