(async () => {
  // ==========================================================================
  //  Настройки
  // ==========================================================================
  const CONCURRENCY = 8;            // сколько недель грузим параллельно
  const REQUEST_TIMEOUT_MS = 20000; // таймаут одного запроса
  const MAX_RETRIES = 3;            // сколько раз повторять неудачный запрос
  const FALLBACK_QUARTER_IDS = [92, 93, 94, 95];

  // Какие оценки за четверть можно выбрать как цель и какая выбрана по умолчанию.
  // Оценка за четверть — это средний балл, округлённый до целого:
  // чтобы стояла T, нужен средний T - 0.5 и выше.
  const TARGET_OPTIONS = [7, 8, 9, 10];
  const DEFAULT_TARGET = 10;
  const MAX_MARK = 10;
  const MIN_MARK = 1;

  // ==========================================================================
  //  Мелкие утилиты
  // ==========================================================================
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (s) => s.replace(/\s+/g, ' ').trim();
  const fmt = (x) => x.toFixed(2);
  const average = (arr) => arr.reduce((sum, x) => sum + x, 0) / arr.length;
  const lerp = (a, b, t) => Math.round(a + (b - a) * t);

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
    }[c]));

  const formatRuDate = (iso) => iso.slice(8) + '.' + iso.slice(5, 7);

  /** Цвет от красного (3) через жёлтый к зелёному (10); `lighten` — осветление 0..1. */
  function colorFor(value, lighten = 0) {
    const t = Math.max(0, Math.min(1, (value - 3) / 7));
    const RED = [226, 85, 75];
    const YELLOW = [245, 190, 60];
    const GREEN = [52, 170, 100];

    const from = t < 0.5 ? RED : YELLOW;
    const to = t < 0.5 ? YELLOW : GREEN;
    const u = t < 0.5 ? t * 2 : (t - 0.5) * 2;

    const rgb = [0, 1, 2].map((i) =>
      lerp(lerp(from[i], to[i], u), 255, lighten)
    );
    return 'rgb(' + rgb.join(',') + ')';
  }

  // ==========================================================================
  //  Параметры страницы: ученик, четверти, недели
  // ==========================================================================
  const pupilId =
    (location.pathname.match(/\/pupil\/(\d+)/) || [])[1];

  let quarters = [
    ...document.querySelectorAll('[id^="db_quarters_menu_"] a[quarter_id]'),
  ].map((a) => ({
    id: a.getAttribute('quarter_id'),
    name: a.textContent.trim(),
  }));

  if (!quarters.length) {
    quarters = FALLBACK_QUARTER_IDS.map((id, i) => ({
      id: String(id),
      name: i + 1 + ' четверть',
    }));
  }

  const now = new Date();
  const todayStamp = now.toISOString().slice(0, 10);

  /** Понедельники всех недель с начала учебного года (1 сентября) до сегодня. */
  function getWeekStarts() {
    const schoolYear = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
    const firstDay = new Date(Date.UTC(schoolYear, 8, 1));

    // сдвигаем на понедельник той недели, в которую попало 1 сентября
    const daysSinceMonday = [6, 0, 1, 2, 3, 4, 5][firstDay.getUTCDay()];
    firstDay.setUTCDate(firstDay.getUTCDate() - daysSinceMonday);

    const weeks = [];
    for (const d = new Date(firstDay); d <= now; d.setUTCDate(d.getUTCDate() + 7)) {
      weeks.push(d.toISOString().slice(0, 10));
    }
    return weeks;
  }

  // ==========================================================================
  //  Окно отчёта
  // ==========================================================================
  const win = window.open('', '_blank');
  if (!win) {
    alert('Браузер заблокировал новую вкладку. Разреши pop-up для этого сайта и запусти ещё раз.');
    return;
  }

  const say = (text) => {
    win.document.body.innerHTML = '<p style="font:16px sans-serif">' + text + '</p>';
  };
  say('Собираю оценки…');

  // ==========================================================================
  //  Загрузка данных
  // ==========================================================================
  /** GET с повторами. Возвращает текст, '' (нет доступа / нет страницы) или null (не удалось). */
  async function fetchText(url) {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(url, {
          credentials: 'include',
          signal: controller.signal,
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });
        clearTimeout(timer);

        if (response.ok) return await response.text();
        if (response.status === 403 || response.status === 404) return '';
      } catch (e) {
        clearTimeout(timer);
      }
      await sleep(800 * (attempt + 1));
    }
    return null;
  }

  /**
   * Достаёт оценки из ячейки.
   * В одной ячейке может стоять несколько оценок через «/» (например «8/9»),
   * каждая из них считается отдельной оценкой.
   */
  function parseMarks(markCell) {
    const marks = [];
    markCell.querySelectorAll('.mark_box strong, strong').forEach((el) => {
      clean(el.textContent)
        .split('/')
        .map((part) => clean(part))
        .filter((part) => /^\d{1,2}$/.test(part))
        .forEach((part) => marks.push(+part));
    });
    return marks;
  }

  const marksSignature = (table) =>
    [...table.querySelectorAll('td.mark')]
      .map((td) => clean(td.textContent))
      .join('|');

  const seenKeys = new Set();
  const marksBySubject = new Map(); // предмет -> [{ date, n, v, q }]
  let lessonsCount = 0;
  let failedCount = 0;
  let duplicateTables = 0;
  let differingDuplicates = 0;

  /** Разбирает HTML одной недели и складывает оценки в marksBySubject. */
  function processWeek(html, quarter, weekStart) {
    const doc = new DOMParser().parseFromString(html, 'text/html');

    // На странице бывают дубли таблиц дня — оставляем последнюю копию.
    const tablesById = new Map();
    doc.querySelectorAll('table.db_table').forEach((table) => {
      const previous = tablesById.get(table.id);
      if (previous) {
        duplicateTables++;
        if (marksSignature(previous) !== marksSignature(table)) differingDuplicates++;
      }
      tablesById.set(table.id, table);
    });

    tablesById.forEach((table, id) => {
      const m = id.match(/db_table_(\d\d)\.(\d\d)\.(\d\d)/);
      const date = m ? '20' + m[3] + '-' + m[2] + '-' + m[1] : weekStart;

      table.querySelectorAll('tbody tr').forEach((tr) => {
        const lessonCell = tr.querySelector('td.lesson');
        if (!lessonCell) return;

        const title = clean(lessonCell.textContent);
        const parsed = title.match(/^(\d+)\.\s*(.+)$/);
        const lessonNumber = parsed ? parsed[1] : '';
        const subject = parsed ? parsed[2] : title;

        lessonsCount++;

        const markCell = tr.querySelector('td.mark');
        if (!markCell || !subject) return;

        parseMarks(markCell).forEach((value, index) => {
          const key = date + '|' + lessonNumber + '|' + subject + '|' + index;
          if (seenKeys.has(key)) return;
          seenKeys.add(key);

          if (!marksBySubject.has(subject)) marksBySubject.set(subject, []);
          marksBySubject.get(subject).push({
            date,
            n: lessonNumber,
            v: value,
            q: quarter.id,
          });
        });
      });
    });
  }

  const tasks = [];
  for (const quarter of quarters) {
    for (const week of getWeekStarts()) tasks.push({ quarter, week });
  }

  const totalTasks = tasks.length;
  let completedTasks = 0;

  function showProgress() {
    const percent = totalTasks ? Math.round((completedTasks / totalTasks) * 100) : 100;
    say('Загружаю оценки… ' + completedTasks + ' / ' + totalTasks + ' (' + percent + '%)');
  }

  async function worker() {
    while (true) {
      const task = tasks.pop();
      if (!task) return;

      const { quarter, week } = task;
      const url = '/pupil/' + pupilId + '/dnevnik/quarter/' + quarter.id + '/week/' + week;
      const html = await fetchText(url);

      completedTasks++;
      showProgress();

      if (html === null) {
        failedCount++;
        continue;
      }
      processWeek(html, quarter, week);
    }
  }

  showProgress();
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, totalTasks) }, () => worker())
  );

  if (!lessonsCount) {
    say('Уроков не нашлось (загрузка не удалась или разметка изменилась). Запусти ещё раз.');
    return;
  }
  if (!marksBySubject.size) {
    say('Уроков: ' + lessonsCount + ', но оценок пока нет. Неудачных запросов: ' + failedCount + '.');
    return;
  }

  // ==========================================================================
  //  Подсчёт
  // ==========================================================================
  const rows = [...marksBySubject.entries()]
    .map(([subject, list]) => {
      list.sort((a, b) => a.date.localeCompare(b.date) || a.n - b.n);
      return { subject, list, avg: average(list.map((o) => o.v)) };
    })
    .sort((a, b) => a.subject.localeCompare(b.subject, 'ru'));

  const allMarks = rows.flatMap((r) => r.list);
  const allValues = allMarks.map((o) => o.v);
  const overallAvg = average(allValues);
  const rowsByAvg = [...rows].sort((a, b) => b.avg - a.avg);
  const bestRow = rowsByAvg[0];
  const worstRow = rowsByAvg[rowsByAvg.length - 1];

  /** Средний балл по списку оценок за четверть (или null, если оценок нет). */
  const quarterAvg = (list, quarterId) => {
    const values = list.filter((o) => o.q === quarterId).map((o) => o.v);
    return values.length ? average(values) : null;
  };

  /** «Текущая» четверть — последняя, в которой уже есть оценки. */
  const currentQuarter = [...quarters]
    .reverse()
    .find((q) => allMarks.some((o) => o.q === q.id));

  /**
   * Сколько оценок `mark` нужно получить, чтобы средний балл за четверть
   * дошёл до `target - 0.5` (то есть за четверть округлилось до `target`).
   * Из условия (sum + mark*n) / (count + n) >= target - 0.5 получается
   * n >= ((2*target - 1)*count - 2*sum) / (2*mark - 2*target + 1).
   * Всё считается в целых числах, без ошибок округления.
   */
  function marksNeeded(values, target, mark) {
    if (!values.length) return 1;
    const sum = values.reduce((s, x) => s + x, 0);
    const deficit = (2 * target - 1) * values.length - 2 * sum;
    if (deficit <= 0) return 0;
    return Math.ceil(deficit / (2 * mark - 2 * target + 1));
  }

  /**
   * Сколько оценок `mark` можно получить (только их, без других), чтобы средний
   * балл за четверть остался не ниже `target - 0.5`. Обратная задача к marksNeeded:
   * из (sum + mark*n) / (count + n) >= target - 0.5 получается
   * n <= (2*sum - (2*target - 1)*count) / (2*target - 1 - 2*mark).
   * Если цель сейчас не выполняется — 0. Для оценок >= target ограничения нет.
   */
  function marksAllowed(values, target, mark) {
    const sum = values.reduce((s, x) => s + x, 0);
    const surplus = 2 * sum - (2 * target - 1) * values.length;
    if (surplus < 0) return 0;
    const denom = 2 * target - 1 - 2 * mark;
    if (denom <= 0) return Infinity;
    return Math.floor(surplus / denom);
  }

  // ==========================================================================
  //  Отрисовка
  // ==========================================================================
  function renderSubjectsChart() {
    const W = 820, LEFT = 150, RIGHT = 60, TOP = 30, ROW_H = 32;
    const H = TOP + rowsByAvg.length * ROW_H + 34;
    const x = (v) => LEFT + ((W - LEFT - RIGHT) * v) / 10;

    let svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px;font:13px sans-serif">`;

    for (let t = 0; t <= 10; t += 2) {
      svg += `
        <line x1="${x(t)}" x2="${x(t)}" y1="${TOP}" y2="${H - 30}" stroke="rgb(226,228,234)"/>
        <text x="${x(t)}" y="${H - 12}" text-anchor="middle" fill="rgb(120,125,140)">${t}</text>`;
    }

    rowsByAvg.forEach((r, i) => {
      const y = TOP + i * ROW_H;
      svg += `
        <text x="${LEFT - 10}" y="${y + ROW_H / 2}" text-anchor="end" dominant-baseline="middle" fill="rgb(40,44,60)">${escapeHtml(r.subject)}</text>
        <rect x="${LEFT}" y="${y + 4}" width="${x(r.avg) - LEFT}" height="${ROW_H - 10}" rx="6" fill="${colorFor(r.avg)}"/>
        <text x="${x(r.avg) + 8}" y="${y + ROW_H / 2}" dominant-baseline="middle" font-weight="bold" fill="rgb(40,44,60)">${fmt(r.avg)}</text>`;
    });

    svg += `
      <line x1="${x(overallAvg)}" x2="${x(overallAvg)}" y1="${TOP - 8}" y2="${H - 30}" stroke="rgb(60,80,200)" stroke-dasharray="5 4" stroke-width="2"/>
      <text x="${x(overallAvg)}" y="${TOP - 14}" text-anchor="middle" fill="rgb(60,80,200)" font-weight="bold">общий ${fmt(overallAvg)}</text>
    </svg>`;
    return svg;
  }

  function renderDistributionChart() {
    const W = 520, H = 240, LEFT = 14, BOTTOM = 34, TOP = 26;
    const counts = Array(11).fill(0);
    allValues.forEach((v) => {
      if (v >= 0 && v <= 10) counts[v]++;
    });
    const maxCount = Math.max(...counts, 1);
    const barSlot = (W - 2 * LEFT) / 10;

    let svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px;font:13px sans-serif">
      <line x1="${LEFT}" x2="${W - LEFT}" y1="${H - BOTTOM}" y2="${H - BOTTOM}" stroke="rgb(200,203,215)"/>`;

    for (let v = 1; v <= 10; v++) {
      const barH = ((H - TOP - BOTTOM) * counts[v]) / maxCount;
      const x = LEFT + (v - 1) * barSlot + 5;
      const y = H - BOTTOM - barH;
      const w = barSlot - 10;

      svg += `<rect x="${x}" y="${y}" width="${w}" height="${barH}" rx="6" fill="${colorFor(v)}"/>`;
      if (counts[v]) {
        svg += `<text x="${x + w / 2}" y="${y - 7}" text-anchor="middle" font-weight="bold" fill="rgb(40,44,60)">${counts[v]}</text>`;
      }
      svg += `<text x="${x + w / 2}" y="${H - BOTTOM + 20}" text-anchor="middle" fill="rgb(120,125,140)">${v}</text>`;
    }
    return svg + '</svg>';
  }

  const renderKpi = (label, value, sub, bg) => `
    <div class="kpi" style="background:${bg}">
      <div class="kl">${label}</div>
      <div class="kv">${value}</div>
      <div class="ks">${sub}</div>
    </div>`;

  function renderKpis() {
    const quarterKpis = quarters
      .map((q) => {
        const values = allMarks.filter((o) => o.q === q.id).map((o) => o.v);
        return values.length
          ? renderKpi(escapeHtml(q.name), fmt(average(values)), values.length + ' оц.', colorFor(average(values), 0.55))
          : renderKpi(escapeHtml(q.name), '—', 'нет оценок', 'rgb(236,237,243)');
      })
      .join('');

    return (
      renderKpi('Общий средний балл', fmt(overallAvg), allValues.length + ' оценок', colorFor(overallAvg, 0.55)) +
      quarterKpis +
      renderKpi('Лучший предмет', fmt(bestRow.avg), escapeHtml(bestRow.subject), colorFor(bestRow.avg, 0.55)) +
      renderKpi('Слабейший предмет', fmt(worstRow.avg), escapeHtml(worstRow.subject), colorFor(worstRow.avg, 0.55))
    );
  }

  const avgCell = (x) =>
    x == null
      ? '<td class="mut">—</td>'
      : `<td style="background:${colorFor(x, 0.6)}"><b>${fmt(x)}</b></td>`;

  const avgCellId = (x, id) =>
    x == null
      ? `<td id="${id}" class="mut">—</td>`
      : `<td id="${id}" style="background:${colorFor(x, 0.6)}"><b>${fmt(x)}</b></td>`;

  function renderSummaryTable() {
    const header =
      '<tr><th>Предмет</th>' +
      quarters.map((q) => `<th>${escapeHtml(q.name)}</th>`).join('') +
      '<th>Итого</th><th>Оценок</th></tr>';

    const body = rows
      .map(
        (r) =>
          `<tr><td>${escapeHtml(r.subject)}</td>` +
          quarters.map((q) => avgCell(quarterAvg(r.list, q.id))).join('') +
          avgCell(r.avg) +
          `<td>${r.list.length}</td></tr>`
      )
      .join('');

    const footer =
      '<tr class="sum"><td>Все предметы</td>' +
      quarters.map((q) => avgCell(quarterAvg(allMarks, q.id))).join('') +
      avgCell(overallAvg) +
      `<td>${allValues.length}</td></tr>`;

    return `<table class="tbl">${header}${body}${footer}</table>`;
  }

  const markChip = (v) => `<span class="m" style="background:${colorFor(v)}">${v}</span>`;

  /**
   * Запас, когда цель уже достигнута: какая самая низкая оценка допустима
   * и сколько оценок каждого достоинства ниже цели можно получить.
   */
  function buildReserveHtml(values, target) {
    const options = [];
    for (let mark = target - 1; mark >= MIN_MARK; mark--) {
      const count = marksAllowed(values, target, mark);
      if (count < 1) break; // чем ниже оценка, тем меньше можно — дальше только нули
      options.push({ mark, count });
    }

    if (!options.length) {
      return `Запаса нет: любая оценка ниже ${markChip(target)} снизит средний балл ниже границы. Оценки ${target} и выше не опасны.`;
    }

    const lowest = options[options.length - 1].mark;
    const list = options
      .map((o) => `<b>${o.count} ×</b> ${markChip(o.mark)}`)
      .join(' <span class="mut">или</span> ');

    return (
      `Запас: самая низкая оценка, после которой за четверть всё ещё будет ${markChip(target)} — ${markChip(lowest)}. ` +
      `Сколько таких оценок можно получить (каждый вариант отдельно): ${list}. ` +
      `Оценки ${target} и выше не опасны.`
    );
  }

  /**
   * Подсказка под названием предмета: что нужно получить, чтобы за текущую
   * четверть стояла оценка `target`. Возвращает { ok, html }.
   */
  function buildTargetHint(row, target) {
    const qName = escapeHtml(currentQuarter.name);
    const values = row.list.filter((o) => o.q === currentQuarter.id).map((o) => o.v);

    if (!values.length) {
      return {
        ok: false,
        html: `${qName}: оценок пока нет — чтобы стояла ${markChip(target)}, достаточно одной оценки ${target} или выше`,
      };
    }

    const current = average(values);
    if (marksNeeded(values, target, MAX_MARK) === 0) {
      const above = current >= target + 0.5 ? ' — это даже выше цели' : '';
      return {
        ok: true,
        html:
          `${qName}: ${markChip(target)} уже есть (средний ${fmt(current)})${above} ✓` +
          `<div class="reserve">${buildReserveHtml(values, target)}</div>`,
      };
    }

    const options = [];
    for (let mark = MAX_MARK; mark >= target; mark--) {
      options.push(`<b>${marksNeeded(values, target, mark)} ×</b> ${markChip(mark)}`);
    }
    return {
      ok: false,
      html:
        `Чтобы за ${qName.toLowerCase()} стояла ${markChip(target)}, нужно получить: ` +
        options.join(' <span class="mut">или</span> ') +
        ` <span class="mut">(сейчас ${fmt(current)})</span>`,
    };
  }

  function renderTargetPicker(index) {
    const buttons = TARGET_OPTIONS.map(
      (t) =>
        `<button class="tg${t === DEFAULT_TARGET ? ' on' : ''}" data-i="${index}" data-t="${t}">${t}</button>`
    ).join('');
    return `<div class="picker noprint"><span class="mut">Хочу за четверть:</span>${buttons}</div>`;
  }

  function renderCard(row, index) {
    const hint = buildTargetHint(row, DEFAULT_TARGET);

    const markRows = row.list
      .map(
        (o, markIdx) => `
        <tr>
          <td>${formatRuDate(o.date)}</td>
          <td>${o.n ? o.n + ' урок' : ''}</td>
          <td id="mc-${index}-${markIdx}"><span class="m" data-card="${index}" data-mark="${markIdx}" data-orig="${o.v}" style="background:${colorFor(o.v)}">${o.v}</span></td>
        </tr>`
      )
      .join('');

    const quarterRows = quarters
      .map((q) => {
        const count = row.list.filter((o) => o.q === q.id).length;
        return `
        <tr>
          <td>${escapeHtml(q.name)}</td>
          <td>${count ? count + ' оц.' : ''}</td>
          ${avgCellId(quarterAvg(row.list, q.id), 'qa-' + index + '-' + q.id)}
        </tr>`;
      })
      .join('');

    return `
      <div class="card" data-card="${index}">
        <h3>${escapeHtml(row.subject)}<span class="badge" style="background:${colorFor(row.avg)}">${fmt(row.avg)}</span></h3>
        ${renderTargetPicker(index)}
        <div class="goal${hint.ok ? ' goal-ok' : ''}" id="goal-${index}">${hint.html}</div>
        <button class="reset-edit noprint" data-card="${index}">↺ сбросить правки</button>
        <table class="tbl">
          <tr><th>Дата</th><th>Урок</th><th>Оценка</th></tr>
          ${markRows}
          <tr class="head"><th colspan="3">По четвертям</th></tr>
          ${quarterRows}
          <tr class="sum"><td>Итого</td><td>${row.list.length} оц.</td>${avgCellId(row.avg, 'qa-' + index + '-total')}</tr>
        </table>
      </div>`;
  }

  const REPORT_CSS = `
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    @page { size: A4; margin: 12mm; }
    body { font: 15px/1.45 "Segoe UI", system-ui, sans-serif; margin: 0; background: rgb(244,245,250); color: rgb(35,38,55); }
    .wrap { max-width: 1100px; margin: 0 auto; padding: 28px 20px 60px; }
    .top { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 6px; }
    h1 { margin: 0; font-size: 28px; }
    h2 { margin: 0 0 12px; font-size: 18px; }
    button { border: 0; border-radius: 10px; padding: 9px 16px; background: rgb(60,80,200); color: white; font: inherit; cursor: pointer; }
    .hint { margin: 0 0 16px; color: rgb(120,125,140); font-size: 13px; }
    .panel { background: white; border-radius: 14px; padding: 18px 22px; margin: 0 0 20px; box-shadow: 0 1px 4px rgba(20,25,60,.08); }
    .kpis { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 20px; }
    .kpi { flex: 1 1 150px; border-radius: 14px; padding: 14px 18px; box-shadow: 0 1px 4px rgba(20,25,60,.08); }
    .kl { font-size: 13px; color: rgb(70,74,95); }
    .kv { font-size: 30px; font-weight: 700; line-height: 1.2; }
    .ks { font-size: 12px; color: rgb(70,74,95); }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 18px; }
    .card { background: white; border-radius: 14px; padding: 16px 18px; box-shadow: 0 1px 4px rgba(20,25,60,.08); }
    .card h3 { margin: 0 0 10px; display: flex; justify-content: space-between; align-items: center; font-size: 17px; }
    .badge { border-radius: 20px; padding: 2px 12px; font-size: 15px; }
    .picker { display: flex; align-items: center; gap: 6px; margin: 0 0 8px; font-size: 13px; }
    .picker .tg { margin: 0; padding: 3px 12px; border-radius: 8px; background: rgb(232,235,250); color: rgb(60,80,200); font-weight: 600; }
    .picker .tg.on { background: rgb(60,80,200); color: white; }
    .goal { margin: -2px 0 10px; padding: 7px 10px; border-radius: 8px; background: rgb(244,245,250); font-size: 13px; }
    .goal-ok { background: rgb(226,245,234); color: rgb(30,110,60); }
    .reserve { margin-top: 6px; padding-top: 6px; border-top: 1px dashed rgb(150,205,175); color: rgb(30,80,50); }
    .tbl { border-collapse: collapse; width: 100%; }
    .tbl th, .tbl td { padding: 6px 10px; text-align: left; border-bottom: 1px solid rgb(236,237,243); }
    .tbl th { background: rgb(244,245,250); font-weight: 600; font-size: 13px; }
    .tbl .head th { background: rgb(232,235,250); }
    .tbl .sum td { font-weight: 700; border-top: 2px solid rgb(200,203,215); }
    .mut { color: rgb(150,153,170); }
    .m { display: inline-block; min-width: 26px; text-align: center; border-radius: 8px; padding: 1px 6px; font-weight: 700; }
    .note { color: rgb(120,125,140); font-size: 13px; }
    @media print {
      body { background: white; }
      .wrap { padding: 0; }
      .noprint { display: none; }
      .panel, .card, .kpi { box-shadow: none; border: 1px solid rgb(225,227,235); break-inside: avoid; }
      .grid { grid-template-columns: repeat(2, 1fr); }
    }
    .m[data-mark] { cursor: pointer; }
    .m[data-mark]:hover { filter: brightness(1.12); }
    .m.m-changed { outline: 2px solid rgba(60,80,200,.55); outline-offset: 2px; }
    .m-orig { font-size: 10px; text-decoration: line-through; color: rgb(170,173,190); vertical-align: middle; margin-right: 3px; }
    .edit-picker { position: fixed; background: white; border-radius: 12px; box-shadow: 0 4px 24px rgba(20,25,60,.22); padding: 10px; display: none; flex-wrap: wrap; gap: 5px; width: 195px; z-index: 9999; }
    .edit-picker.visible { display: flex; }
    .ep-label { width: 100%; font-size: 11px; color: rgb(120,125,140); margin-bottom: 2px; }
    .ep-btn { margin: 0; flex: 0 0 calc(20% - 4px); padding: 6px 0; border-radius: 8px; font-size: 13px; text-align: center; }
    .ep-cancel { flex: 1 0 100%; margin-top: 4px; padding: 5px; border-radius: 8px; font-size: 12px; background: rgb(244,245,250); color: rgb(100,105,130); text-align: center; }
    .reset-edit { display: none; margin: 0 0 8px; padding: 4px 10px; border-radius: 8px; font-size: 12px; background: transparent; color: rgb(100,105,130); border: 1px solid rgb(215,218,230); }
    .reset-edit:hover { background: rgb(244,245,250); }`;

  function renderReport() {
    const failedWarning = failedCount
      ? `<p style="color:rgb(200,30,30)">Не загрузилось недель: ${failedCount} — запусти ещё раз</p>`
      : '';

    return `
      <meta charset="utf-8">
      <title>Оценки ${todayStamp}</title>
      <style>${REPORT_CSS}</style>
      <div class="wrap">
        <div class="top">
          <h1>Оценки</h1>
          <div class="noprint">
            <button id="pr">Сохранить в PDF</button>
          </div>
        </div>
        <p class="hint noprint">Кнопка «Сохранить в PDF» открывает окно печати: в поле «Принтер» выбери «Сохранить как PDF».</p>
        <div class="kpis">${renderKpis()}</div>
        ${failedWarning}
        <div class="panel"><h2>Средний балл по предметам</h2>${renderSubjectsChart()}</div>
        <div class="panel"><h2>Распределение оценок</h2>${renderDistributionChart()}</div>
        <div class="panel"><h2>Сводка по четвертям</h2>${renderSummaryTable()}</div>
        <h2>Все оценки по предметам</h2>
        <p class="note">У каждого предмета можно выбрать, какую оценку ты хочешь за четверть (${TARGET_OPTIONS[0]}–${TARGET_OPTIONS[TARGET_OPTIONS.length - 1]}). Подсказки считаются для текущей четверти (${escapeHtml(currentQuarter.name)}): оценка за четверть — это средний балл, округлённый до целого, поэтому для оценки T нужен средний T − 0.5 и выше. Если цель уже достигнута, показывается запас: какие низкие оценки можно получить, не потеряв её.</p>
        <div class="grid">${rows.map((r, i) => renderCard(r, i)).join('')}</div>
        <p class="note">Служебная проверка: повторяющихся таблиц дней — ${duplicateTables}, из них с разными отметками — ${differingDuplicates} (использована последняя копия).</p>
      </div>`;
  }

  // ==========================================================================
  //  Правки оценок (интерактивная замена)
  // ==========================================================================
  const overrides = new Map(); // cardIdx -> Map<markIdx, newValue>

  /** Возвращает row с применёнными правками. */
  function getEffRow(cardIdx) {
    const row = rows[cardIdx];
    const ov = overrides.get(cardIdx);
    if (!ov || !ov.size) return row;
    return {
      ...row,
      list: row.list.map((o, mi) => ov.has(mi) ? { ...o, v: ov.get(mi) } : o),
    };
  }

  /** Пересчитывает и обновляет badge, ячейки четвертей и подсказку цели в карточке. */
  function recalcCard(cardIdx) {
    const effRow = getEffRow(cardIdx);
    const effAvg = average(effRow.list.map((o) => o.v));

    const card = win.document.querySelector(`.card[data-card="${cardIdx}"]`);
    if (!card) return;

    // Значок среднего в заголовке
    const badge = card.querySelector('.badge');
    badge.textContent = fmt(effAvg);
    badge.style.background = colorFor(effAvg);

    // Средние по четвертям
    quarters.forEach((q) => {
      const td = win.document.getElementById('qa-' + cardIdx + '-' + q.id);
      if (!td) return;
      const vals = effRow.list.filter((o) => o.q === q.id).map((o) => o.v);
      if (!vals.length) {
        td.className = 'mut'; td.removeAttribute('style'); td.innerHTML = '—';
      } else {
        const a = average(vals);
        td.className = ''; td.style.background = colorFor(a, 0.6); td.innerHTML = `<b>${fmt(a)}</b>`;
      }
    });

    // Итоговая ячейка
    const tdTotal = win.document.getElementById('qa-' + cardIdx + '-total');
    if (tdTotal) {
      tdTotal.style.background = colorFor(effAvg, 0.6);
      tdTotal.innerHTML = `<b>${fmt(effAvg)}</b>`;
    }

    // Подсказка цели (с текущей выбранной целью)
    const activeBtn = card.querySelector('.tg.on');
    const target = activeBtn ? +activeBtn.dataset.t : DEFAULT_TARGET;
    const hint = buildTargetHint(effRow, target);
    const goal = win.document.getElementById('goal-' + cardIdx);
    goal.className = 'goal' + (hint.ok ? ' goal-ok' : '');
    goal.innerHTML = hint.html;

    // Кнопка сброса — показываем только если есть правки
    const ov = overrides.get(cardIdx);
    card.querySelector('.reset-edit').style.display = (ov && ov.size) ? 'inline-block' : 'none';
  }

  // ==========================================================================
  //  Вывод
  // ==========================================================================
  win.document.open();
  win.document.write(renderReport());
  win.document.close();
  win.document.title = 'Оценки ' + todayStamp;

  // Выбор желаемой оценки за четверть у предмета (обработчик вешаем отсюда,
  // а не через <script> в отчёте, чтобы не упереться в CSP сайта).

  // Плавающий пикер для замены оценки
  const editPicker = win.document.createElement('div');
  editPicker.className = 'edit-picker noprint';
  editPicker.innerHTML =
    '<span class="ep-label">Заменить оценку на:</span>' +
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
      .map((v) => `<button class="ep-btn" data-v="${v}" style="background:${colorFor(v)};color:white;font-weight:700">${v}</button>`)
      .join('') +
    '<button class="ep-cancel">отмена</button>';
  win.document.body.appendChild(editPicker);

  let pickerTarget = null; // { cardIdx, markIdx, span }

  function showEditPicker(span) {
    pickerTarget = { cardIdx: +span.dataset.card, markIdx: +span.dataset.mark, span };
    const rect = span.getBoundingClientRect();
    editPicker.style.left = Math.min(rect.left, win.innerWidth - 210) + 'px';
    editPicker.style.top = (rect.bottom + 6) + 'px';
    editPicker.classList.add('visible');
  }

  function hideEditPicker() {
    editPicker.classList.remove('visible');
    pickerTarget = null;
  }

  win.document.addEventListener('click', (event) => {
    const markSpan = event.target.closest && event.target.closest('.m[data-mark]');
    const tg      = !markSpan && event.target.closest && event.target.closest('.tg');
    const epBtn   = event.target.closest && event.target.closest('.ep-btn');
    const epCancel = event.target.closest && event.target.closest('.ep-cancel');
    const resetBtn = event.target.closest && event.target.closest('.reset-edit');

    // Закрываем пикер при клике вне него
    if (!editPicker.contains(event.target) && !markSpan) hideEditPicker();

    // Клик по оценке → открыть / закрыть пикер
    if (markSpan) {
      if (pickerTarget && pickerTarget.span === markSpan) { hideEditPicker(); return; }
      showEditPicker(markSpan);
      return;
    }

    // Выбор новой оценки из пикера
    if (epBtn && pickerTarget) {
      const { cardIdx, markIdx, span } = pickerTarget;
      const newVal  = +epBtn.dataset.v;
      const origVal = +span.dataset.orig;

      if (!overrides.has(cardIdx)) overrides.set(cardIdx, new Map());
      if (newVal === origVal) {
        overrides.get(cardIdx).delete(markIdx);
      } else {
        overrides.get(cardIdx).set(markIdx, newVal);
      }

      // Обновляем чип оценки
      const td = win.document.getElementById('mc-' + cardIdx + '-' + markIdx);
      if (newVal !== origVal) {
        td.innerHTML =
          `<span class="m-orig">${origVal}</span>` +
          `<span class="m m-changed" data-card="${cardIdx}" data-mark="${markIdx}" data-orig="${origVal}" style="background:${colorFor(newVal)}">${newVal}</span>`;
      } else {
        td.innerHTML = `<span class="m" data-card="${cardIdx}" data-mark="${markIdx}" data-orig="${origVal}" style="background:${colorFor(origVal)}">${origVal}</span>`;
      }

      recalcCard(cardIdx);
      hideEditPicker();
      return;
    }

    if (epCancel) { hideEditPicker(); return; }

    // Сброс всех правок карточки
    if (resetBtn) {
      const cardIdx = +resetBtn.dataset.card;
      overrides.delete(cardIdx);
      rows[cardIdx].list.forEach((o, mi) => {
        const td = win.document.getElementById('mc-' + cardIdx + '-' + mi);
        if (td) td.innerHTML = `<span class="m" data-card="${cardIdx}" data-mark="${mi}" data-orig="${o.v}" style="background:${colorFor(o.v)}">${o.v}</span>`;
      });
      recalcCard(cardIdx);
      return;
    }

    // Смена желаемой оценки за четверть (учитываем текущие правки)
    if (tg) {
      const index  = +tg.dataset.i;
      const target = +tg.dataset.t;
      const hint   = buildTargetHint(getEffRow(index), target);

      const goal = win.document.getElementById('goal-' + index);
      goal.className = 'goal' + (hint.ok ? ' goal-ok' : '');
      goal.innerHTML = hint.html;

      tg.parentElement.querySelectorAll('.tg').forEach((b) => b.classList.toggle('on', b === tg));
    }
  });

  win.document.getElementById('pr').onclick = () => {
    win.focus();
    win.print();
  };
})();
