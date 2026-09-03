"use strict";

const DATA_URL = "data/turning_points.json";
const COLORS = {
  bottom: "#47d7a0",
  top: "#f17282",
  text: "#dce3eb",
  muted: "#718092",
  grid: "#252d38",
  surface: "#0d1117",
};

let model = null;
let activeSide = "bottom";
let activeThreshold = "70";
let bucketChart = null;
let eventChart = null;
let candleChart = null;
let candleYears = 5;
let selectedEventIndex = 0;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function number(value, digits = 1) {
  return value === null || value === undefined || Number.isNaN(Number(value))
    ? "—"
    : Number(value).toFixed(digits);
}

function percent(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  const numeric = Number(value);
  return `${numeric > 0 ? "+" : ""}${numeric.toFixed(digits)}%`;
}

function rate(value) {
  return value === null || value === undefined ? "—" : `${Number(value).toFixed(1)}%`;
}

function returnClass(value) {
  if (value === null || value === undefined || Math.abs(Number(value)) < 0.005) return "";
  return Number(value) > 0 ? "positive" : "negative";
}

function scoreBand(side, score) {
  if (score >= 75) return side === "bottom" ? "极度超卖" : "极度过热";
  if (score >= 60) return side === "bottom" ? "超卖" : "过热";
  return "正常";
}

function autoThreshold(score) {
  if (score >= 90) return "90";
  if (score >= 80) return "80";
  return "70";
}

function setText(selector, value) {
  const node = $(selector);
  if (node) node.textContent = value;
}

function stateClass(state) {
  const upper = String(state).toUpperCase();
  if (upper.includes("BOTTOM") || upper.includes("OVERSOLD")) return "bottom-state";
  if (upper.includes("TOP") || upper.includes("OVERHEATED")) return "top-state";
  return "";
}

function stateLabel(state) {
  const labels = {
    "INSUFFICIENT DATA": "数据不足",
    "POTENTIAL BOTTOM": "潜在低点",
    "POTENTIAL TOP": "潜在高点",
    "EXTREME OVERSOLD": "极度超卖",
    OVERSOLD: "超卖",
    "EXTREME OVERHEATED": "极度过热",
    OVERHEATED: "过热",
    NORMAL: "正常",
  };
  return labels[state] || state;
}

function triggerLabel(trigger) {
  const labels = {
    None: "无",
    "3D breakout": "突破前三日最高收盘价",
    "MA5 reclaim": "重新站上 MA5",
    "3D breakout + MA5 reclaim": "突破前三日最高收盘价 + 重新站上 MA5",
    "3D breakdown": "跌破前三日最低收盘价",
    "MA5 breakdown": "跌破 MA5",
    "3D breakdown + MA5 breakdown": "跌破前三日最低收盘价 + 跌破 MA5",
  };
  return labels[trigger] || trigger;
}

function renderComponents(target, components, side) {
  const labels =
    side === "bottom"
      ? [
          ["RSI 超卖 · 40%", components.rsi_score],
          ["快速下跌 · 60%", components.capitulation_score],
        ]
      : [
          ["RSI 超买", components.rsi_score],
          ["低恐慌 / 自满", components.complacency_score],
          ["价格偏离", components.stretch_score],
          ["快速上涨", components.euphoria_score],
        ];
  $(target).innerHTML = labels
    .map(
      ([label, value]) => `
        <div class="component">
          <span>${label}</span>
          <div class="mini-track"><i style="width:${clamp(Number(value) || 0, 0, 100)}%"></i></div>
          <strong>${number(value, 0)}</strong>
        </div>`,
    )
    .join("");
}

function renderModelAudit() {
  const audit = model.model_audit;
  if (!audit) return;
  setText("#audit-period", `样本外：${audit.evaluation_start} 至 ${audit.evaluation_end}`);
  setText("#audit-bottom-v1", rate(audit.bottom.v1.hit_rate));
  setText("#audit-bottom-v2", rate(audit.bottom.v2.hit_rate));
  setText("#audit-top-v1", rate(audit.top.v1.hit_rate));
  setText("#audit-top-v2", rate(audit.top.candidate.hit_rate));
  setText(
    "#audit-bottom-note",
    `V2 在 ${audit.bottom.v2.event_count} 个独立案例中命中 ${audit.bottom.v2.hit_count} 次；旧模型为 ${audit.bottom.v1.hit_count} / ${audit.bottom.v1.event_count}。`,
  );
}

function renderOverview() {
  const current = model.current;
  const panel = $(".signal-overview");
  panel.className = `panel signal-overview ${stateClass(current.market_state)}`;

  const titles = {
    "POTENTIAL BOTTOM": "可能进入相对低点区域",
    "POTENTIAL TOP": "可能进入相对高点区域",
    "EXTREME OVERSOLD": "跌得很多，但还没有止跌",
    OVERSOLD: "市场有些超卖，需要继续观察",
    "EXTREME OVERHEATED": "涨得很多，顶部风险较高",
    OVERHEATED: "市场有些过热，需要注意风险",
    NORMAL: "目前既不明显超卖，也不明显过热",
  };
  setText("#overview-title", titles[current.market_state] || stateLabel(current.market_state));

  let summary = "低点评分和高点评分均未达到关注阈值，当前更适合观察而不是预判转折。";
  if (current.market_state === "POTENTIAL BOTTOM") {
    summary = "超卖、恐慌和价格偏离条件较强，同时已经出现止跌确认；这仍是历史概率，不是买入指令。";
  } else if (current.market_state === "POTENTIAL TOP") {
    summary = "过热与价格延伸条件较强，同时已经出现转弱确认；这代表风险回报恶化，不等于做空信号。";
  } else if (current.market_state.includes("OVERSOLD")) {
    summary = "低点条件已经明显，但止跌确认尚未完成，价格仍可能继续下探。";
  } else if (current.market_state.includes("OVERHEATED")) {
    summary = "高点风险已经明显，但强趋势仍可能延续，需要等待转弱确认。";
  } else if (current.top_weakness) {
    summary = `短线已经转弱，但高点评分只有 ${number(current.top_score, 1)}，暂不构成潜在高点。`;
  } else if (current.bottom_reversal) {
    summary = `短线已经止跌，但低点评分只有 ${number(current.bottom_score, 1)}，并非典型超卖反转。`;
  }
  setText("#overview-summary", summary);

  const oversoldAnswer = current.bottom_score >= 75 ? "非常明显" : current.bottom_score >= 60 ? "有一些" : "不明显";
  const oversoldTone = current.bottom_score >= 75 ? "safe" : current.bottom_score >= 60 ? "watch" : "neutral";
  const fearAnswer = current.vix_percentile >= 80 ? "非常恐慌" : current.vix_percentile >= 60 ? "偏恐慌" : current.vix_percentile <= 30 ? "比较平静" : "一般";
  const fearTone = current.vix_percentile >= 80 ? "watch" : current.vix_percentile >= 60 ? "watch" : "neutral";
  const topAnswer = current.top_score >= 75 ? "很高" : current.top_score >= 60 ? "需要注意" : "不高";
  const topTone = current.top_score >= 75 ? "risk" : current.top_score >= 60 ? "watch" : "safe";
  $("#novice-answers").innerHTML = `
    <div class="novice-answer ${oversoldTone}">
      <span>现在明显超卖吗？</span>
      <strong>${oversoldAnswer}</strong>
      <small>低点评分 ${number(current.bottom_score, 1)}，60 分以上才进入关注区</small>
    </div>
    <div class="novice-answer ${fearTone}">
      <span>市场现在恐慌吗？</span>
      <strong>${fearAnswer}</strong>
      <small>VIX 恐慌百分位为 ${rate(current.vix_percentile)}</small>
    </div>
    <div class="novice-answer ${current.bottom_reversal ? "safe" : "watch"}">
      <span>已经看到止跌了吗？</span>
      <strong>${current.bottom_reversal ? "看到了" : "还没有"}</strong>
      <small>${current.bottom_reversal ? triggerLabel(current.bottom_trigger_type) : "仍需等待价格重新走强"}</small>
    </div>
    <div class="novice-answer ${topTone}">
      <span>顶部风险高吗？</span>
      <strong>${topAnswer}</strong>
      <small>高点评分 ${number(current.top_score, 1)}，60 分以上才需要关注</small>
    </div>`;

  let nextStep = "先观察低点或高点评分是否升到 60 以上。";
  if (current.market_state === "POTENTIAL BOTTOM") nextStep = "关注止跌能否持续，并结合历史回撤理解风险。";
  else if (current.market_state === "POTENTIAL TOP") nextStep = "控制追高风险，但不要把高点评分直接当成做空信号。";
  else if (current.bottom_score >= 60) nextStep = "等待止跌确认；高分本身不代表已经见底。";
  else if (current.top_score >= 60) nextStep = "等待转弱确认；高分本身不代表马上下跌。";
  else if (current.top_weakness) nextStep = "单独出现转弱不代表顶部，重点看高点评分会不会升到 60。";
  setText("#overview-next-step", nextStep);
}

function renderCurrent() {
  const current = model.current;
  setText("#current-price", `$${number(current.price, 2)}`);
  setText("#current-date", current.date);
  setText("#market-state", stateLabel(current.market_state));
  setText("#footer-updated", `最后更新 ${model.last_updated}`);

  const marketState = $("#market-state");
  marketState.className = `state-badge ${stateClass(current.market_state)}`;

  setText("#bottom-score", number(current.bottom_score, 1));
  setText("#top-score", number(current.top_score, 1));
  setText("#bottom-band", scoreBand("bottom", current.bottom_score));
  setText("#top-band", scoreBand("top", current.top_score));
  $("#bottom-score-bar").style.width = `${clamp(current.bottom_score, 0, 100)}%`;
  $("#top-score-bar").style.width = `${clamp(current.top_score, 0, 100)}%`;

  const bottomConfirmation = $("#bottom-confirmation");
  bottomConfirmation.textContent = current.bottom_reversal ? "已经止跌" : "还没止跌";
  bottomConfirmation.classList.toggle("confirmed", current.bottom_reversal);
  setText(
    "#bottom-trigger",
    current.bottom_reversal ? triggerLabel(current.bottom_trigger_type) : "未突破前三日最高收盘价，也未重新站上 MA5",
  );

  const topConfirmation = $("#top-confirmation");
  topConfirmation.textContent = current.top_weakness ? "已经转弱" : "还没转弱";
  topConfirmation.classList.toggle("confirmed", current.top_weakness);
  setText(
    "#top-trigger",
    current.top_weakness ? triggerLabel(current.top_trigger_type) : "未跌破前三日最低收盘价，也未跌破 MA5",
  );

  renderComponents("#bottom-components", model.bottom_components, "bottom");
  renderComponents("#top-components", model.top_components, "top");

  const rawMetrics = [
    ["RSI 14", number(current.rsi14, 1), "低于 30 通常表示超卖", ""],
    ["VIX", number(current.vix, 2), "越高代表市场越恐慌", ""],
    ["VIX 恐慌百分位", rate(current.vix_percentile), "高于 80% 才算很恐慌", ""],
    ["价格相对 20日均线", percent(current.stretch_ma20), "负数表示低于均线", returnClass(current.stretch_ma20)],
    ["价格相对 50日均线", percent(current.stretch_ma50), "负数表示低于均线", returnClass(current.stretch_ma50)],
    ["最近5日涨跌", percent(current.return_5d), "负数表示近5日下跌", returnClass(current.return_5d)],
    ["最近10日涨跌", percent(current.return_10d), "负数表示近10日下跌", returnClass(current.return_10d)],
  ];
  $("#raw-metrics").innerHTML = rawMetrics
    .map(
      ([label, value, detail, className]) => `
        <div class="raw-metric">
          <span class="metric-label">${label}</span>
          <strong class="${className}">${value}</strong>
          <span>${detail}</span>
        </div>`,
    )
    .join("");
  renderOverview();
  renderModelAudit();
}

function renderOutcome() {
  const stats = model[`${activeSide}_statistics`][activeThreshold];
  const currentScore = model.current[`${activeSide}_score`];
  setText("#event-count", stats.event_count);
  const selectionText = currentScore < 60
    ? `当前${activeSide === "bottom" ? "低点" : "高点"}评分为 ${number(currentScore, 1)}，还在普通区。下面用评分 ≥ ${activeThreshold} 的更极端案例作参考。`
    : `当前${activeSide === "bottom" ? "低点" : "高点"}评分为 ${number(currentScore, 1)}，下面查看相同强度的历史案例。`;
  setText("#selection-description", selectionText);
  setText("#win-rate-title", activeSide === "bottom" ? "正收益率" : "下跌概率");

  const horizon20 = stats.horizons["20"];
  const horizon60 = stats.horizons["60"];
  $("#outcome-kpis").innerHTML = [
    [activeSide === "bottom" ? "20日后上涨的比例" : "20日后下跌的比例", rate(horizon20.win_rate), `约 ${Math.round(stats.event_count * horizon20.win_rate / 100)} / ${stats.event_count} 次`],
    ["20日后的典型涨跌", percent(horizon20.median_return), "一半案例高于它，一半低于它"],
    ["60日后的典型涨跌", percent(horizon60.median_return), "观察更长时间后的结果"],
    ["期间典型最大回撤", percent(stats.median_max_drawdown_20d), "过程中可能承受的下跌"],
  ]
    .map(
      ([label, value, detail]) => `
        <div class="outcome-kpi">
          <span>${label}</span>
          <strong class="${returnClass(label.includes("比例") ? null : value.replace("%", ""))}">${value}</strong>
          <small>${detail}</small>
        </div>`,
    )
    .join("");

  $("#outcome-table").innerHTML = [5, 10, 20, 60]
    .map((horizon) => {
      const row = stats.horizons[String(horizon)];
      return `
        <tr>
          <td>${horizon}日</td>
          <td>${rate(row.win_rate)}</td>
          <td class="${returnClass(row.average_return)}">${percent(row.average_return)}</td>
          <td class="${returnClass(row.median_return)}">${percent(row.median_return)}</td>
          <td class="${returnClass(row.best_return)}">${percent(row.best_return)}</td>
          <td class="${returnClass(row.worst_return)}">${percent(row.worst_return)}</td>
        </tr>`;
    })
    .join("");
}

function comparisonMetrics(stats) {
  const horizon = stats.horizons["20"];
  return [
    [activeSide === "bottom" ? "20日后上涨比例" : "20日后下跌比例", rate(horizon.win_rate), ""],
    ["20日后的典型涨跌", percent(horizon.median_return), returnClass(horizon.median_return)],
    ["期间典型最大回撤", percent(stats.median_max_drawdown_20d), returnClass(stats.median_max_drawdown_20d)],
  ]
    .map(
      ([label, value, className]) => `
        <div class="comparison-metric">
          <span>${label}</span>
          <strong class="${className}">${value}</strong>
        </div>`,
    )
    .join("");
}

function renderComparison() {
  const comparison = model.confirmation_comparison[activeSide][activeThreshold];
  const without = comparison.without_confirmation;
  const confirmed = comparison.with_confirmation;
  setText("#without-count", `样本=${without.event_count}`);
  setText("#with-count", `样本=${confirmed.event_count}`);
  setText("#without-label", "只看高分，不等确认");
  setText("#with-label", activeSide === "bottom" ? "高分当天还要求止跌" : "高分当天还要求转弱");
  setText(
    "#comparison-title",
    activeSide === "bottom" ? "等待止跌后，历史结果会更好吗？" : "等待转弱后，顶部判断会更准吗？",
  );
  $("#without-comparison").innerHTML = comparisonMetrics(without);
  $("#with-comparison").innerHTML = comparisonMetrics(confirmed);
  setText(
    "#comparison-note",
    `比较两种方法：只看${activeSide === "bottom" ? "低点" : "高点"}高分，与高分当天还出现${activeSide === "bottom" ? "止跌" : "转弱"}。`,
  );

  const verdict = $("#comparison-verdict");
  const before20 = without.horizons["20"];
  const after20 = confirmed.horizons["20"];
  verdict.className = "comparison-verdict";
  if (confirmed.event_count < 5 || after20.win_rate === null) {
    verdict.classList.add("caution");
    verdict.textContent = `结论：样本太少。确认组只有 ${confirmed.event_count} 个完整案例，现在还不能判断这条确认规则有没有用。`;
  } else {
    const winDelta = after20.win_rate - before20.win_rate;
    const medianDelta = after20.median_return - before20.median_return;
    const favorableMedianDelta = activeSide === "bottom" ? medianDelta : -medianDelta;
    const isBetter = winDelta > 2 && favorableMedianDelta >= 0;
    const isWorse = winDelta < -2 || favorableMedianDelta < 0;
    verdict.classList.add(isBetter ? "good" : isWorse ? "bad" : "caution");
    const conclusion = isBetter ? "有改善" : isWorse ? "没有改善" : "变化不明显";
    verdict.textContent = `结论：${conclusion}。加入${activeSide === "bottom" ? "止跌" : "转弱"}确认后，${activeSide === "bottom" ? "20日后上涨比例" : "20日后下跌比例"}从 ${rate(before20.win_rate)} 变为 ${rate(after20.win_rate)}，典型涨跌从 ${percent(before20.median_return)} 变为 ${percent(after20.median_return)}。`;
  }

  const warning = $("#sample-warning");
  warning.hidden = confirmed.event_count >= 10;
  warning.textContent =
    confirmed.event_count === 0
      ? "确认组没有完整的历史样本，不能判断确认信号是否有效。"
      : `确认组仅 ${confirmed.event_count} 个样本，统计波动很大，不能据此下结论。建议至少积累 10–20 个独立案例。`;
}

function chartBase() {
  return {
    animationDuration: 450,
    textStyle: { color: COLORS.text, fontFamily: "Consolas, monospace" },
    tooltip: {
      trigger: "axis",
      backgroundColor: "#10161e",
      borderColor: "#313c49",
      textStyle: { color: "#edf2f7", fontSize: 11 },
    },
  };
}

function renderFiveYearChart() {
  if (!window.echarts || !model?.five_year_chart) return;
  const source = model.five_year_chart;
  const end = new Date(`${source.end}T00:00:00`);
  const cutoff = new Date(end);
  cutoff.setFullYear(cutoff.getFullYear() - candleYears);
  const cutoffText = cutoff.toISOString().slice(0, 10);
  const bars = source.bars.filter((bar) => bar.date >= cutoffText);
  const visibleDates = new Set(bars.map((bar) => bar.date));
  const bottomEvents = source.bottom_events.filter((event) => visibleDates.has(event.date));
  const topEvents = source.top_events.filter((event) => visibleDates.has(event.date));
  const barByDate = new Map(bars.map((bar) => [bar.date, bar]));

  $("#backtest-summary").innerHTML = `
    <span>当前范围<strong>${bars[0]?.date || "—"} 至 ${bars.at(-1)?.date || "—"}</strong></span>
    <span class="bottom-count">低点条件<strong>${bottomEvents.length} 次</strong>（确认 ${bottomEvents.filter((event) => event.confirmed).length} 次）</span>
    <span class="top-count">高位风险<strong>${topEvents.length} 次</strong>（转弱 ${topEvents.filter((event) => event.confirmed).length} 次）</span>`;

  const markerData = (events, side) =>
    events.map((event) => {
      const bar = barByDate.get(event.date);
      const markerPrice = side === "bottom" ? bar.low * 0.985 : bar.high * 1.015;
      return {
        value: [event.date, markerPrice],
        event,
        symbolSize: event.confirmed ? 17 : 11,
        itemStyle: {
          color: event.confirmed
            ? COLORS[side]
            : side === "bottom"
              ? "rgba(71, 215, 160, 0.12)"
              : "rgba(241, 114, 130, 0.12)",
          borderColor: COLORS[side],
          borderWidth: event.confirmed ? 1 : 2,
        },
      };
    });

  if (!candleChart) candleChart = echarts.init($("#five-year-chart"));
  candleChart.setOption(
    {
      ...chartBase(),
      animationDuration: 300,
      grid: { left: 58, right: 24, top: 46, bottom: 78 },
      legend: {
        top: 10,
        right: 8,
        itemWidth: 18,
        itemHeight: 8,
        textStyle: { color: COLORS.muted, fontSize: 10 },
        data: ["QQQ 日K", "MA20", "MA50"],
      },
      tooltip: {
        ...chartBase().tooltip,
        trigger: "axis",
        axisPointer: { type: "cross", label: { backgroundColor: "#26313d" } },
        formatter: (params) => {
          const candle = params.find((item) => item.seriesType === "candlestick");
          if (!candle?.data?.bar) return "";
          const bar = candle.data.bar;
          const eventItems = params.filter((item) => item.data?.event);
          const change = (bar.close / bar.open - 1) * 100;
          const rows = [
            `<strong>${bar.date}</strong>`,
            `开盘 ${number(bar.open, 2)}　最高 ${number(bar.high, 2)}`,
            `最低 ${number(bar.low, 2)}　收盘 ${number(bar.close, 2)}`,
            `当日涨跌 ${percent(change, 2)}`,
            `<span style="color:${COLORS.bottom}">低点评分 ${number(bar.bottom_score, 1)}</span>　<span style="color:${COLORS.top}">高点评分 ${number(bar.top_score, 1)}</span>`,
          ];
          eventItems.forEach((item) => {
            const event = item.data.event;
            const side = item.seriesName.includes("低点") ? "bottom" : "top";
            rows.push(
              `<span style="color:${COLORS[side]}"><strong>${side === "bottom" ? "低点条件" : "高位风险"}${event.confirmed ? "（出现价格确认）" : "（未确认）"}</strong></span>`,
              `评分 ${number(event.score, 1)}｜20日后 ${percent(event.future_20d_return)}｜60日后 ${percent(event.future_60d_return)}`,
              event.confirmed ? `确认方式：${triggerLabel(event.trigger_type)}` : "当天尚未出现价格确认",
            );
          });
          return rows.join("<br>");
        },
      },
      xAxis: {
        type: "category",
        data: bars.map((bar) => bar.date),
        boundaryGap: true,
        axisLine: { lineStyle: { color: COLORS.grid } },
        axisTick: { show: false },
        axisLabel: {
          color: COLORS.muted,
          fontSize: 9,
          hideOverlap: true,
          formatter: (value) => value.slice(0, 7),
        },
      },
      yAxis: {
        type: "value",
        scale: true,
        splitNumber: 6,
        name: "QQQ 价格（美元）",
        nameTextStyle: { color: COLORS.muted, fontSize: 9 },
        splitLine: { lineStyle: { color: COLORS.grid } },
        axisLabel: { color: COLORS.muted, fontSize: 9 },
      },
      dataZoom: [
        { type: "inside", start: 0, end: 100, minValueSpan: 20 },
        {
          type: "slider",
          start: 0,
          end: 100,
          bottom: 16,
          height: 22,
          borderColor: COLORS.grid,
          backgroundColor: "#0a0e13",
          fillerColor: "rgba(142, 184, 255, 0.14)",
          handleStyle: { color: "#8eb8ff", borderColor: "#8eb8ff" },
          moveHandleStyle: { color: "#8eb8ff" },
          textStyle: { color: COLORS.muted, fontSize: 9 },
        },
      ],
      series: [
        {
          name: "QQQ 日K",
          type: "candlestick",
          data: bars.map((bar) => ({
            value: [bar.open, bar.close, bar.low, bar.high],
            bar,
          })),
          itemStyle: {
            color: "#aebed0",
            color0: "#4e5b6a",
            borderColor: "#c5d3e2",
            borderColor0: "#687688",
          },
        },
        {
          name: "MA20",
          type: "line",
          data: bars.map((bar) => bar.ma20),
          showSymbol: false,
          lineStyle: { color: "#8eb8ff", width: 1.25, opacity: 0.9 },
        },
        {
          name: "MA50",
          type: "line",
          data: bars.map((bar) => bar.ma50),
          showSymbol: false,
          lineStyle: { color: "#e5b965", width: 1.15, opacity: 0.82 },
        },
        {
          name: "低点条件",
          type: "scatter",
          data: markerData(bottomEvents, "bottom"),
          symbol: "triangle",
          z: 8,
        },
        {
          name: "高位风险",
          type: "scatter",
          data: markerData(topEvents, "top"),
          symbol: "triangle",
          symbolRotate: 180,
          z: 8,
        },
      ],
    },
    true,
  );
}

function renderBucketChart() {
  if (!window.echarts) return;
  const bucketResult = model[`${activeSide}_score_buckets`];
  const buckets = bucketResult.buckets;
  const color = COLORS[activeSide];
  setText("#monotonic-result", bucketResult.monotonic_20d_median ? "单调性：通过" : "单调性：未通过");
  $("#monotonic-result").className = `test-result ${bucketResult.monotonic_20d_median ? "pass" : "fail"}`;

  if (!bucketChart) bucketChart = echarts.init($("#bucket-chart"));
  bucketChart.setOption(
    {
      ...chartBase(),
      grid: { left: 52, right: 54, top: 48, bottom: 42 },
      legend: {
        top: 8,
        right: 0,
        textStyle: { color: COLORS.muted, fontSize: 10 },
        data: ["20日中位收益", activeSide === "bottom" ? "正收益率" : "下跌概率"],
      },
      xAxis: {
        type: "category",
        data: buckets.map((item) => item.bucket),
        axisLine: { lineStyle: { color: COLORS.grid } },
        axisTick: { show: false },
        axisLabel: { color: COLORS.muted, fontSize: 10 },
      },
      yAxis: [
        {
          type: "value",
          name: "收益率 %",
          nameTextStyle: { color: COLORS.muted, fontSize: 9 },
          splitLine: { lineStyle: { color: COLORS.grid } },
          axisLabel: { color: COLORS.muted, formatter: "{value}%", fontSize: 9 },
        },
        {
          type: "value",
          min: 0,
          max: 100,
          name: "概率 %",
          nameTextStyle: { color: COLORS.muted, fontSize: 9 },
          splitLine: { show: false },
          axisLabel: { color: COLORS.muted, formatter: "{value}%", fontSize: 9 },
        },
      ],
      series: [
        {
          name: "20日中位收益",
          type: "bar",
          data: buckets.map((item) => item.median_return_20d),
          itemStyle: { color, borderRadius: [4, 4, 0, 0] },
          barMaxWidth: 46,
          label: {
            show: true,
            position: "outside",
            color: COLORS.text,
            fontSize: 9,
            formatter: (item) => percent(item.value),
          },
          markLine: {
            silent: true,
            symbol: "none",
            label: { show: false },
            lineStyle: { color: COLORS.muted, width: 1 },
            data: [{ yAxis: 0 }],
          },
        },
        {
          name: activeSide === "bottom" ? "正收益率" : "下跌概率",
          type: "line",
          yAxisIndex: 1,
          data: buckets.map((item) => item.win_rate_20d),
          symbol: "circle",
          symbolSize: 7,
          lineStyle: { color: "#8eb8ff", width: 2 },
          itemStyle: { color: "#8eb8ff" },
        },
      ],
    },
    true,
  );
}

function renderEventChart(event) {
  if (!window.echarts || !event || !event.path) return;
  const color = COLORS[activeSide];
  const offsets = event.path.map((point) => String(point.offset));
  setText("#event-chart-title", `${activeSide === "bottom" ? "低点" : "高点"}案例 • 评分 ${number(event.score, 1)}`);
  setText("#event-date-chip", event.date);
  if (!eventChart) eventChart = echarts.init($("#event-chart"));
  eventChart.setOption(
    {
      ...chartBase(),
      grid: { left: 52, right: 22, top: 30, bottom: 42 },
      xAxis: {
        type: "category",
        boundaryGap: false,
        data: offsets,
        axisLine: { lineStyle: { color: COLORS.grid } },
        axisTick: { show: false },
        axisLabel: {
          color: COLORS.muted,
          fontSize: 9,
          interval: 9,
          formatter: (value) => (Number(value) > 0 ? `+${value}` : value),
        },
      },
      yAxis: {
        type: "value",
        scale: true,
        name: "事件日 = 100",
        nameTextStyle: { color: COLORS.muted, fontSize: 9 },
        splitLine: { lineStyle: { color: COLORS.grid } },
        axisLabel: { color: COLORS.muted, fontSize: 9 },
      },
      series: [
        {
          type: "line",
          data: event.path.map((point) => point.normalized),
          showSymbol: false,
          smooth: false,
          lineStyle: { color, width: 2 },
          areaStyle: { color, opacity: 0.06 },
          markLine: {
            silent: true,
            symbol: "none",
            label: { color, fontSize: 9 },
            lineStyle: { color, type: "dashed", width: 1 },
            data: [
              { xAxis: "0", label: { formatter: "事件日" } },
              { yAxis: 100, label: { formatter: "基准 100", color: COLORS.muted } },
            ],
          },
          markPoint: {
            symbol: "circle",
            symbolSize: 9,
            label: { show: false },
            itemStyle: { color },
            data: [{ coord: ["0", 100] }],
          },
        },
      ],
    },
    true,
  );
}

function renderEvents() {
  const events = model[`recent_${activeSide}_events`];
  const eventList = $("#event-list");
  selectedEventIndex = 0;
  if (!events.length) {
    eventList.innerHTML = '<div class="empty-state">没有满足条件且已完成 60 日观察期的事件。</div>';
    return;
  }
  eventList.innerHTML = events
    .map(
      (event, index) => `
        <button type="button" class="event-button ${index === 0 ? "active" : ""}" data-event-index="${index}">
          <span class="event-date">${event.date}</span>
          <span>${number(event.score, 1)}</span>
          <span>${number(event.rsi14, 1)}</span>
          <span>${number(event.vix, 1)}</span>
          <span class="${returnClass(event.future_20d_return)}">${percent(event.future_20d_return)}</span>
          <span class="${returnClass(event.future_60d_return)}">${percent(event.future_60d_return)}</span>
          <span class="${returnClass(event.max_drawdown_20d)}">${percent(event.max_drawdown_20d)}</span>
        </button>`,
    )
    .join("");
  renderEventChart(events[0]);

  $$(".event-button").forEach((button) => {
    button.addEventListener("click", () => {
      selectedEventIndex = Number(button.dataset.eventIndex);
      $$(".event-button").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      renderEventChart(events[selectedEventIndex]);
      if (window.innerWidth < 820) $("#event-chart").scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });
}

function renderHistorical() {
  document.body.dataset.side = activeSide;
  $$("#side-toggle button").forEach((button) =>
    button.classList.toggle("active", button.dataset.side === activeSide),
  );
  $$("#threshold-toggle button").forEach((button) =>
    button.classList.toggle("active", button.dataset.threshold === activeThreshold),
  );
  renderOutcome();
  renderComparison();
  renderBucketChart();
  renderEvents();
}

function bindControls() {
  $$("#year-toggle button").forEach((button) => {
    button.addEventListener("click", () => {
      candleYears = Number(button.dataset.years);
      $$("#year-toggle button").forEach((item) =>
        item.classList.toggle("active", item === button),
      );
      renderFiveYearChart();
    });
  });

  $$("#side-toggle button").forEach((button) => {
    button.addEventListener("click", () => {
      activeSide = button.dataset.side;
      activeThreshold = autoThreshold(model.current[`${activeSide}_score`]);
      renderHistorical();
    });
  });
  $$("#threshold-toggle button").forEach((button) => {
    button.addEventListener("click", () => {
      activeThreshold = button.dataset.threshold;
      renderHistorical();
    });
  });

  const dialog = $("#methodology-dialog");
  $("#open-methodology").addEventListener("click", () => dialog.showModal());
  $("#close-methodology").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });

  window.addEventListener("resize", () => {
    candleChart?.resize();
    bucketChart?.resize();
    eventChart?.resize();
  });
}

async function init() {
  try {
    const response = await fetch(DATA_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    model = await response.json();
    activeSide = model.current.bottom_score >= model.current.top_score ? "bottom" : "top";
    activeThreshold = autoThreshold(model.current[`${activeSide}_score`]);
    renderCurrent();
    bindControls();
    renderFiveYearChart();
    renderHistorical();
  } catch (error) {
    console.error("Failed to initialize QQQ Turning Point", error);
    $("#load-error").hidden = false;
    setText("#market-state", "数据错误");
  }
}

init();
