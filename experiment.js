/* Pure chart/view helpers: shared by the browser and offline contract tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PivotExperiment = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";
  const COLORS = { bottom: "#47d7a0", top: "#f17282", answer: "#f6ce73", fit: "#b3a5ff", muted: "#a1afbf", grid: "#252d38" };
  const NAMES = { bottom: "低点", top: "高点", walkforward: "向后预测", fullfit: "历史拟合", baseline: "原规则", answer: "事后答案" };
  const safe = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const number = (v, n = 1) => v === null || v === undefined || !Number.isFinite(Number(v)) ? "—" : Number(v).toFixed(n);
  const rate = (v) => v === null || v === undefined ? "—" : `${number(v)}%`;
  const future = (v) => v === null || v === undefined ? "待观察" : `${Number(v) > 0 ? "+" : ""}${number(v)}%`;

  function validate(data) {
    if (data?.version !== "pivot-supervised-v1" || !Array.isArray(data.bars) || !data.bars.length) throw new Error("Missing experiment data");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data.evaluation_end) || data.evaluation_end > data.as_of) throw new Error("Invalid experiment dates");
    for (const side of ["bottom", "top"]) {
      if (!Array.isArray(data.sides?.[side]?.pivots)) throw new Error("Missing pivot labels");
      for (const mode of ["walkforward", "fullfit", "baseline"]) {
        if (!Array.isArray(data.sides[side].events?.[mode])) throw new Error("Missing signal mode");
      }
    }
    return data;
  }

  function view(data, { years = 5, side = "both", mode = "walkforward", showAnswers = true } = {}) {
    validate(data);
    const cutoff = new Date(`${data.as_of}T00:00:00Z`);
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);
    const start = cutoff.toISOString().slice(0, 10);
    const bars = data.bars.filter((bar) => bar.date >= start);
    const dates = new Set(bars.map((b) => b.date));
    const sides = side === "both" ? ["bottom", "top"] : [side];
    const modes = mode === "compare" ? ["walkforward", "fullfit"] : [mode];
    const markers = [], stats = {};
    for (const s of sides) {
      stats[s] = {};
      const pivots = data.sides[s].pivots.filter((date) => dates.has(date));
      if (showAnswers) pivots.forEach((date) => markers.push({ date, side: s, mode: "answer" }));
      for (const m of ["walkforward", "fullfit", "baseline"]) {
        const events = data.sides[s].events[m].filter((event) => dates.has(event.date));
        const mature = events.filter((event) => event.status !== "pending");
        const hits = mature.filter((event) => event.status === "hit");
        const covered = new Set(hits.filter((event) => dates.has(event.matched_date)).map((event) => event.matched_date)).size;
        stats[s][m] = { signals: mature.length, hits: hits.length, pivots: pivots.length, covered, precision: mature.length ? hits.length / mature.length * 100 : null, recall: pivots.length ? covered / pivots.length * 100 : null, pending: events.length - mature.length };
        if (modes.includes(m)) events.forEach((event) => markers.push({ ...event, side: s, mode: m }));
      }
    }
    return { data, bars, sides, modes, markers, stats, mode, showAnswers };
  }

  function dayDescription(v, date) {
    const bar = v.bars.find((row) => row.date === date);
    if (!bar) return "";
    const rows = [`<strong>${safe(date)} · 收盘 ${number(bar.close, 2)}</strong>`];
    for (const side of v.sides) {
      for (const mode of v.modes) rows.push(`${NAMES[side]}${NAMES[mode]}分数：${number(bar[`${side}_${mode}`])} / 100`);
    }
    v.markers.filter((item) => item.date === date).forEach((item) => {
      if (item.mode === "answer") rows.push(`<b style="color:${COLORS.answer}">◆ 事后${NAMES[item.side]}答案</b>：看完后续行情才能标注`);
      else {
        const status = item.status === "pending" ? "后续日期不足，待观察" : item.status === "hit" ? `靠近 ${safe(item.matched_date)} 的${NAMES[item.side]}` : "未靠近定义内的高低点";
        rows.push(`<b style="color:${COLORS[item.side]}">${NAMES[item.mode]} · ${NAMES[item.side]}提示</b>：${status}`);
        rows.push(`20 日后 ${future(item.future_20d_return)}　60 日后 ${future(item.future_60d_return)}`);
      }
    });
    if (!v.markers.some((item) => item.date === date && item.mode !== "answer")) rows.push("当天没有独立提示；分数过线也可能处于防重复期。");
    rows.push("分数不是成功概率。历史拟合学过答案，不代表当时预测。");
    return rows.join("<br>");
  }

  function option(v, compact = false) {
    const bars = v.bars, byDate = new Map(bars.map((b) => [b.date, b]));
    const pendingStart = bars.find((b) => b.date > v.data.evaluation_end)?.date;
    const series = [
      { name: "QQQ 日K", type: "candlestick", data: bars.map((bar) => ({ value: [bar.open, bar.close, bar.low, bar.high], bar })), itemStyle: { color: "#aebed0", color0: "#4e5b6a", borderColor: "#c5d3e2", borderColor0: "#687688" },
        markArea: pendingStart ? { silent: true, itemStyle: { color: "rgba(154,170,190,0.07)" }, label: { show: true, color: COLORS.muted, fontSize: 12, position: "insideTop" }, data: [[{ name: "待观察", xAxis: pendingStart }, { xAxis: bars.at(-1).date }]] } : undefined },
      { name: "MA20", type: "line", data: bars.map((b) => b.ma20), showSymbol: false, lineStyle: { color: "#8eb8ff", width: 1.2 } },
      { name: "MA50", type: "line", data: bars.map((b) => b.ma50), showSymbol: false, lineStyle: { color: "#dcae5c", width: 1.2 } },
    ];
    for (const side of v.sides) {
      for (const mode of ["answer", ...v.modes]) {
        if (mode === "answer" && !v.showAnswers) continue;
        const distance = mode === "answer" ? 0 : mode === "walkforward" ? .025 : .05;
        series.push({ name: `${NAMES[mode]} · ${NAMES[side]}`, type: "scatter", symbol: mode === "answer" ? "diamond" : mode === "fullfit" ? "circle" : "triangle", symbolRotate: mode === "walkforward" && side === "top" ? 180 : 0,
          symbolSize: mode === "answer" ? 11 : 13, z: mode === "answer" ? 10 : 9,
          data: v.markers.filter((m) => m.side === side && m.mode === mode).map((marker) => {
            const bar = byDate.get(marker.date);
            const price = mode === "answer" ? bar.close : side === "bottom" ? bar.low * (1 - distance) : bar.high * (1 + distance);
            return { value: [marker.date, price], marker, itemStyle: { color: mode === "answer" ? COLORS.answer : mode === "fullfit" ? "#0d1117" : COLORS[side], borderColor: mode === "fullfit" ? COLORS.fit : mode === "answer" ? "#32291a" : COLORS[side], borderWidth: 2, opacity: marker.status === "pending" ? .65 : 1 } };
          }),
        });
      }
    }
    return {
      animation: false,
      aria: { enabled: true, description: "QQQ 日线。金色菱形为事后高低点；绿红三角为向后预测，紫色空心圆为历史拟合。" },
      grid: { left: compact ? 48 : 62, right: 16, top: 52, bottom: 78 },
      legend: { data: ["QQQ 日K", "MA20", "MA50"], top: 8, right: 8, textStyle: { color: COLORS.muted, fontSize: 12 } },
      tooltip: { trigger: "axis", triggerOn: "mousemove|click", confine: true, backgroundColor: "#10161e", borderColor: "#313c49", textStyle: { color: "#edf2f7", fontSize: 14 }, extraCssText: "max-width:min(440px,85vw);white-space:normal;line-height:1.7;", axisPointer: { type: "cross" }, formatter: (params) => dayDescription(v, params.find((p) => p.data?.bar)?.data.bar.date || params[0]?.axisValue) },
      xAxis: { type: "category", data: bars.map((b) => b.date), boundaryGap: true, axisLine: { lineStyle: { color: COLORS.grid } }, axisTick: { show: false }, axisLabel: { color: COLORS.muted, fontSize: 12, hideOverlap: true, formatter: (value) => value.slice(0, 7) } },
      yAxis: { type: "value", scale: true, splitNumber: 5, name: "QQQ / 美元", nameTextStyle: { color: COLORS.muted, fontSize: 12 }, axisLabel: { color: COLORS.muted, fontSize: 12 }, splitLine: { lineStyle: { color: COLORS.grid } } },
      dataZoom: [{ type: "inside", minValueSpan: 20 }, { type: "slider", bottom: 14, height: 24, borderColor: COLORS.grid, backgroundColor: "#0a0e13", fillerColor: "rgba(142,184,255,.14)", handleStyle: { color: "#8eb8ff" }, textStyle: { color: COLORS.muted, fontSize: 12 } }], series,
    };
  }

  function statsHTML(v) {
    return v.sides.map((side) => {
      const rows = v.modes.map((mode) => {
        const m = v.stats[side][mode];
        return `<div class="experiment-stat-row"><span>${NAMES[mode]}</span><div><strong>${rate(m.precision)}</strong><small>提示命中 ${m.hits}/${m.signals}</small></div><div><strong>${rate(m.recall)}</strong><small>${NAMES[side]}覆盖 ${m.covered}/${m.pivots}</small></div>${m.pending ? `<p>${m.pending} 个新提示待观察，不计入命中率</p>` : ""}</div>`;
      }).join("");
      const baseline = v.stats[side].baseline;
      return `<article class="experiment-stat-card ${side}-stat"><h3>${NAMES[side]}识别</h3>${rows}<p class="experiment-baseline">原规则对照：提示命中 ${baseline.hits}/${baseline.signals}，覆盖 ${baseline.covered}/${baseline.pivots} 个${NAMES[side]}</p></article>`;
    }).join("");
  }

  function warning(mode) {
    if (mode === "fullfit") return "正在看历史拟合：模型学过这些答案。这里不是当时的预测，也不是未来胜率。";
    if (mode === "compare") return "三种标记只作对照，统计分开计算；紫色历史拟合不能当成当时成功预测。";
    return "正在看向后预测：每年只用此前已成熟标签训练。历史已被反复研究，不是全新盲测或实盘成绩。";
  }

  function focus(v, date) {
    const index = v.bars.findIndex((bar) => bar.date === date);
    if (index < 0) return null;
    return { index, startValue: v.bars[Math.max(0, index - 22)].date, endValue: v.bars[Math.min(v.bars.length - 1, index + 20)].date };
  }
  return { validate, view, option, statsHTML, dayDescription, warning, focus, safe };
});
