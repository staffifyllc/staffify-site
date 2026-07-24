// Slack notifier for the sales hub. Posts via chat.postMessage with the bot token.
// Env: SLACK_BOT_TOKEN, SLACK_CHANNEL (a channel ID like C0123ABC, most reliable; a #name works only
// if the bot has channels:read). Best-effort: never throws into the caller.

export async function slackNotify(text, blocks) {
    const token = process.env.SLACK_BOT_TOKEN;
    const channel = process.env.SLACK_CHANNEL;
    if (!token || !channel) return { ok: false, skipped: true };
    try {
        const res = await fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ channel, text, ...(blocks ? { blocks } : {}), unfurl_links: false }),
        });
        const j = await res.json().catch(() => ({}));
        return { ok: !!j.ok, error: j.error };
    } catch (e) {
        return { ok: false, error: String(e.message || e) };
    }
}
