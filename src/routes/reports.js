const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');

// ─── Shared data fetch ────────────────────────────────────────────────────────

async function fetchReportData(id) {
  const [sessionResult, scoresResult, transcriptsResult] = await Promise.all([
    supabase.from('sessions').select('*').eq('id', id).single(),
    supabase.from('scores').select('*').eq('session_id', id),
    supabase.from('transcripts').select('*').eq('session_id', id).order('timestamp_seconds'),
  ]);
  if (sessionResult.error) throw sessionResult.error;
  const session = sessionResult.data;
  if (!session.report) throw new Error('Report not yet generated for this session');
  return {
    session,
    scores: scoresResult.data || [],
    transcripts: transcriptsResult.data || [],
    report: session.report,
  };
}

// ─── GET /api/reports/:id ─────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { session, scores, transcripts, report } = await fetchReportData(id);
    res.json({
      report,
      session: {
        id: session.id,
        title: session.title,
        topic: session.topic,
        status: session.status,
        started_at: session.started_at,
        ended_at: session.ended_at,
        group_name: session.group_name,
      },
      scores,
      transcripts,
    });
  } catch (err) {
    console.error('[Reports] Error:', err.message);
    const status = err.message.includes('not yet generated') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ─── GET /api/reports/:id/export/csv ─────────────────────────────────────────
// Downloads a CSV of per-participant scores
// Columns: participant, overall, topic_adherence, depth, material_application,
//          bloom_level, utterances, talk_time_seconds

router.get('/:id/export/csv', async (req, res) => {
  try {
    const { id } = req.params;
    const { session, scores, report } = await fetchReportData(id);

    const headers = [
      'participant',
      'overall_score',
      'topic_adherence',
      'depth',
      'material_application',
      'bloom_level',
      'utterances',
      'talk_time_seconds',
      'recommendation',
    ];

    const escape = (val) => {
      if (val == null) return '';
      const str = String(val);
      // Wrap in quotes if contains comma, newline, or quote
      if (str.includes(',') || str.includes('\n') || str.includes('"')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    };

    const rows = scores.map(s => {
      const insight = report.individual_insights?.[s.speaker_tag] || {};
      return [
        escape(s.speaker_tag),
        escape(s.overall_score?.toFixed(2)),
        escape(s.topic_adherence?.toFixed(2)),
        escape(s.depth?.toFixed(2)),
        escape(s.material_application?.toFixed(2)),
        escape(s.bloom_level || ''),
        escape(s.utterance_count || ''),
        escape(s.utterance_count ? Math.round(s.utterance_count * 0.4 * 5) : ''),
        escape(insight.recommendation || ''),
      ].join(',');
    });

    const csv = [headers.join(','), ...rows].join('\n');
    const filename = `learnlive-${session.title.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-scores.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);

  } catch (err) {
    console.error('[Reports] CSV export error:', err.message);
    const status = err.message.includes('not yet generated') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ─── GET /api/reports/:id/export/pdf ─────────────────────────────────────────
// Returns a self-contained HTML file that browsers print-to-PDF cleanly.
// Avoids puppeteer/wkhtmltopdf dependency — the frontend triggers window.print()
// via a redirect, or faculty use the browser's Save as PDF.
// Content-Type: text/html with print-optimised CSS.

router.get('/:id/export/pdf', async (req, res) => {
  try {
    const { id } = req.params;
    const { session, scores, transcripts, report } = await fetchReportData(id);

    const duration = session.started_at && session.ended_at
      ? Math.round((new Date(session.ended_at) - new Date(session.started_at)) / 60000)
      : null;

    const date = new Date(session.started_at || session.created_at)
      .toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

    const bloomColors = {
      REMEMBER: '#a89878', UNDERSTAND: '#6b7c8b', APPLY: '#5c7a5e',
      ANALYSE: '#7a5c8b', EVALUATE: '#8b6914', CREATE: '#8b3a2a',
    };
    const bloomLevels = { REMEMBER: 1, UNDERSTAND: 2, APPLY: 3, ANALYSE: 4, EVALUATE: 5, CREATE: 6 };

    function scoreColor(v) {
      if (v == null) return '#8b7355';
      return v >= 7 ? '#2d6a4f' : v >= 4 ? '#8b6914' : '#8b3a2a';
    }

    function bloomPips(level) {
      const n = bloomLevels[level] || 0;
      const color = bloomColors[level] || '#a89878';
      return Array.from({ length: 6 }, (_, i) =>
        `<span style="display:inline-block;width:7px;height:7px;border-radius:1px;margin-right:2px;background:${i < n ? color : '#e8e0d0'}"></span>`
      ).join('') + `<span style="font-size:10px;color:${color};margin-left:4px;font-family:monospace">${level || '—'}</span>`;
    }

    function scoreBox(label, value) {
      const color = scoreColor(value);
      return `
        <div style="text-align:center;padding:8px 12px;background:#fdfaf4;border:1px solid #e8e0d0;border-radius:3px;min-width:70px">
          <div style="font-size:20px;font-family:monospace;font-weight:500;color:${color}">${value != null ? value.toFixed(1) : '—'}</div>
          <div style="font-size:9px;font-family:monospace;color:#8b7355;letter-spacing:0.08em;text-transform:uppercase;margin-top:2px">${label}</div>
        </div>`;
    }

    // Individual scorecards HTML
    const individualCards = Object.entries(report.individual_insights || {}).map(([name, insight]) => {
      const score = scores.find(s => s.speaker_tag === name);
      return `
        <div style="background:#fff;border:1px solid #e8e0d0;border-radius:4px;padding:20px;margin-bottom:16px;break-inside:avoid">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px;flex-wrap:wrap;gap:12px">
            <div>
              <div style="font-size:18px;font-weight:500;color:#1a1208;margin-bottom:6px">${name}</div>
              ${score?.bloom_level ? `<div>${bloomPips(score.bloom_level)}</div>` : ''}
            </div>
            ${score ? `
              <div style="display:flex;gap:8px;flex-wrap:wrap">
                ${scoreBox('Overall', score.overall_score)}
                ${scoreBox('Topic', score.topic_adherence)}
                ${scoreBox('Depth', score.depth)}
                ${scoreBox('Material', score.material_application)}
              </div>` : ''}
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
            ${insight.highlight ? `
              <div style="background:#f0f7f3;border:1px solid #c8e0d4;border-radius:3px;padding:10px 12px">
                <div style="font-size:9px;font-family:monospace;color:#2d6a4f;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:4px">What you did well</div>
                <div style="font-size:13px;color:#1a3328;line-height:1.5">${insight.highlight}</div>
              </div>` : ''}
            ${insight.gap ? `
              <div style="background:#fdf3f0;border:1px solid #e0c8c4;border-radius:3px;padding:10px 12px">
                <div style="font-size:9px;font-family:monospace;color:#8b3a2a;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:4px">Area to develop</div>
                <div style="font-size:13px;color:#3a1a14;line-height:1.5">${insight.gap}</div>
              </div>` : ''}
          </div>
          ${insight.recommendation ? `
            <div style="background:#fff;border:1px solid #e8e0d0;border-left:3px solid #8b6914;border-radius:3px;padding:10px 12px">
              <div style="font-size:9px;font-family:monospace;color:#8b6914;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:4px">Recommendation</div>
              <div style="font-size:13px;color:#2a1f0e;line-height:1.5">${insight.recommendation}</div>
            </div>` : ''}
          ${score?.utterance_count ? `
            <div style="margin-top:8px;font-size:10px;font-family:monospace;color:#a89878">
              ${score.utterance_count} utterance${score.utterance_count !== 1 ? 's' : ''} recorded
            </div>` : ''}
        </div>`;
    }).join('');

    // Transcript HTML (abbreviated — last 50 utterances to keep PDF manageable)
    const transcriptRows = transcripts.slice(-50).map(t => `
      <tr>
        <td style="font-size:10px;font-family:monospace;color:#8b6914;padding:4px 8px 4px 0;white-space:nowrap;vertical-align:top">${t.speaker_name || ''}</td>
        <td style="font-size:12px;color:#2a1f0e;padding:4px 0;line-height:1.5">${t.utterance || ''}</td>
      </tr>`).join('');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LearnLive Report — ${session.title}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Crimson+Pro:ital,wght@0,300;0,400;0,500;0,600;1,400&family=DM+Mono:wght@400;500&display=swap');
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Crimson Pro', Georgia, serif; background: #fff; color: #1a1208; font-size: 14px; }
    .page { max-width: 800px; margin: 0 auto; padding: 40px 48px; }
    .section { background: #fff; border: 1px solid #e8e0d0; border-radius: 4px; padding: 24px; margin-bottom: 20px; break-inside: avoid; }
    .label { font-size: 9px; font-family: 'DM Mono', monospace; color: #8b7355; letter-spacing: 0.12em; text-transform: uppercase; margin-bottom: 10px; }
    h1 { font-size: 28px; font-weight: 400; color: #1a1208; letter-spacing: -0.01em; margin-bottom: 6px; line-height: 1.2; }
    .no-print { display: none; }
    @media print {
      body { font-size: 12px; }
      .page { padding: 0; }
      .no-print { display: none !important; }
    }
  </style>
</head>
<body>
<div class="page">

  <!-- Print button (hidden on print) -->
  <div class="no-print" style="display:flex;justify-content:flex-end;margin-bottom:20px">
    <button onclick="window.print()" style="background:#1a1208;color:#f5edd8;border:none;border-radius:3px;padding:8px 20px;cursor:pointer;font-family:'Crimson Pro',serif;font-size:14px">
      Save as PDF
    </button>
  </div>

  <!-- Header -->
  <div style="margin-bottom:28px;padding-bottom:20px;border-bottom:1px solid #e8e0d0">
    <div style="font-size:9px;font-family:monospace;color:#8b7355;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:8px">LearnLive · Post-Session Report</div>
    <h1>${session.title}</h1>
    <p style="font-size:15px;color:#6b5b3e;font-style:italic;margin-bottom:12px">${session.topic || ''}</p>
    <div style="display:flex;gap:24px;flex-wrap:wrap">
      <span style="font-size:11px;font-family:monospace;color:#8b7355">${date}</span>
      ${duration ? `<span style="font-size:11px;font-family:monospace;color:#8b7355">${duration} min</span>` : ''}
      <span style="font-size:11px;font-family:monospace;color:#8b7355">${transcripts.length} utterances</span>
      <span style="font-size:11px;font-family:monospace;color:#8b7355">${scores.length} participant${scores.length !== 1 ? 's' : ''}</span>
    </div>
  </div>

  <!-- Executive summary -->
  <div class="section">
    <div class="label">Executive Summary</div>
    <p style="font-size:16px;line-height:1.7;color:#2a1f0e;font-weight:300">${report.executive_summary || ''}</p>
  </div>

  <!-- Group performance -->
  <div class="section">
    <div class="label">Group Performance</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:16px">
      <div>
        <div style="font-size:9px;font-family:monospace;color:#2d6a4f;letter-spacing:0.08em;margin-bottom:8px">STRENGTHS</div>
        ${(report.group_performance?.strengths || []).map(s => `
          <div style="display:flex;gap:8px;margin-bottom:6px">
            <span style="color:#2d6a4f;flex-shrink:0">✓</span>
            <span style="font-size:13px;color:#2a1f0e;line-height:1.5">${s}</span>
          </div>`).join('')}
      </div>
      <div>
        <div style="font-size:9px;font-family:monospace;color:#8b3a2a;letter-spacing:0.08em;margin-bottom:8px">GAPS</div>
        ${(report.group_performance?.gaps || []).map(g => `
          <div style="display:flex;gap:8px;margin-bottom:6px">
            <span style="color:#8b3a2a;flex-shrink:0">△</span>
            <span style="font-size:13px;color:#2a1f0e;line-height:1.5">${g}</span>
          </div>`).join('')}
      </div>
    </div>
    ${report.group_performance?.bloom_summary ? `
      <div style="background:#fdfaf4;border:1px solid #e8e0d0;border-radius:3px;padding:12px 14px;margin-bottom:12px">
        <div style="font-size:9px;font-family:monospace;color:#8b6914;letter-spacing:0.1em;margin-bottom:4px">BLOOM'S TAXONOMY</div>
        <p style="font-size:13px;color:#2a1f0e;line-height:1.5">${report.group_performance.bloom_summary}</p>
      </div>` : ''}
    ${report.group_performance?.material_coverage ? `
      <div>
        <div style="font-size:9px;font-family:monospace;color:#8b7355;letter-spacing:0.1em;margin-bottom:4px">MATERIAL COVERAGE</div>
        <p style="font-size:13px;color:#2a1f0e;line-height:1.5">${report.group_performance.material_coverage}</p>
      </div>` : ''}
  </div>

  <!-- Individual scorecards -->
  ${Object.keys(report.individual_insights || {}).length > 0 ? `
    <div style="margin-bottom:20px">
      <div class="label">Individual Scorecards</div>
      ${individualCards}
    </div>` : ''}

  <!-- Missed concepts -->
  ${report.missed_concepts?.length > 0 ? `
    <div class="section">
      <div class="label">Concepts Not Covered</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        ${report.missed_concepts.map(c => `
          <span style="display:inline-block;padding:3px 8px;border-radius:2px;font-size:11px;font-family:monospace;background:#fdf3f0;color:#8b3a2a;border:1px solid #e0c8c4">○ ${c}</span>`).join('')}
      </div>
    </div>` : ''}

  <!-- Facilitator notes -->
  ${report.facilitator_notes ? `
    <div style="background:#1a1208;border-radius:4px;padding:20px 24px;margin-bottom:20px">
      <div style="font-size:9px;font-family:monospace;color:#c9b890;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:10px">Facilitator Notes</div>
      <p style="font-size:15px;line-height:1.7;color:#f5edd8;font-weight:300">${report.facilitator_notes}</p>
    </div>` : ''}

  <!-- Transcript (last 50) -->
  ${transcripts.length > 0 ? `
    <div class="section">
      <div class="label">Session Transcript${transcripts.length > 50 ? ' (last 50 utterances)' : ` (${transcripts.length} utterances)`}</div>
      <table style="width:100%;border-collapse:collapse">
        ${transcriptRows}
      </table>
    </div>` : ''}

  <!-- Footer -->
  <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e8e0d0;text-align:center">
    <p style="font-size:10px;font-family:monospace;color:#c4b49a;letter-spacing:0.06em">
      Generated by LearnLive · Scored by AI against Bloom's Taxonomy · ${session.title}
    </p>
  </div>

</div>
<script>
  // Auto-trigger print dialog if ?print=1 is in the URL
  if (new URLSearchParams(window.location.search).get('print') === '1') {
    window.addEventListener('load', () => setTimeout(() => window.print(), 500));
  }
</script>
</body>
</html>`;

    const filename = `learnlive-${session.title.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-report.html`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(html);

  } catch (err) {
    console.error('[Reports] PDF export error:', err.message);
    const status = err.message.includes('not yet generated') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

module.exports = router;
