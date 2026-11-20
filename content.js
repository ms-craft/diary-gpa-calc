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
  const average = (arr) => arr.length ? arr.reduce((sum, x) => sum + x, 0) / arr.length : null;
  const lerp = (a, b, t) => Math.round(a + (b - a) * t);

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
    }[c]));

  const formatRuDate = (iso) => iso.slice(8) + '.' + iso.slice(5, 7);

  // Хранение выбранных предметов по полугодиям в localStorage (на домене дневника)
  const STORAGE_KEY = 'diary-gpa-calc-semester-subjects';
  const OLD_STORAGE_KEY = 'diary-gpa-calc-selected-subjects';
  function loadSemesterSubjects() {
    try {
      const data = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(OLD_STORAGE_KEY);
      return data ? JSON.parse(data) : null;
    } catch { return null; }
  }
  function saveSemesterSubjects(selected) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...selected]));
    } catch {}
  }

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

  if (!pupilId) { alert('Открой страницу нужного ученика в электронном дневнике.'); return; }

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

  const selectedTargets = new Map();

  const seenKeys = new Set();
  const markQuarterOrigin = new Map();
  let crossQuarterDuplicates = 0;
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
          if (seenKeys.has(key)) {
            if (markQuarterOrigin.get(key) !== quarter.id) crossQuarterDuplicates++;
            return;
          }
          seenKeys.add(key);
          markQuarterOrigin.set(key, quarter.id);

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

  // Ответы загружаем параллельно, но обрабатываем строго в одном порядке.
  // Раньше из-за гонки повтор одной и той же оценки мог попасть в случайную четверть.
  const responses = new Array(tasks.length);
  let nextTask = 0;
  async function worker() {
    while (nextTask < tasks.length) {
      const i = nextTask++;
      const { quarter, week } = tasks[i];
      const url = '/pupil/' + pupilId + '/dnevnik/quarter/' + quarter.id + '/week/' + week;
      responses[i] = await fetchText(url);
      completedTasks++;
      showProgress();
    }
  }

  showProgress();
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, totalTasks) }, () => worker()));
  tasks.forEach(({ quarter, week }, i) => {
    if (responses[i] === null) failedCount++;
    else if (responses[i]) processWeek(responses[i], quarter, week);
  });

  if (!marksBySubject.size) {
    say('Текущих оценок не найдено. Проверь страницу дневника.');
    return;
  }

  // ==========================================================================
  //  Подсчёт
  // ==========================================================================
  const rows = [...marksBySubject.entries()].map(([subject, list]) => {
    list.sort((a, b) => a.date.localeCompare(b.date) || a.n - b.n);
    const avg = average(list.map((o) => o.v));
    return { subject, list, avg, roundedAvg: avg === null ? null : Math.round(avg) };
  });
  rows.sort((a, b) => a.subject.localeCompare(b.subject, 'ru'));

  const allMarks = rows.flatMap((r) => r.list);

  // Выбор предметов с оценкой по полугодиям
  const allSubjectNames = rows.map((r) => r.subject);
  const savedSelection = loadSemesterSubjects();
  const semesterSubjects = new Set(
    savedSelection
      ? savedSelection.filter((s) => allSubjectNames.includes(s))
      : []
  );

  /** Средний балл по списку оценок за четверть (или null, если оценок нет). */
  const quarterAvg = (list, quarterId) => {
    const values = list.filter((o) => o.q === quarterId).map((o) => o.v);
    return values.length ? average(values) : null;
  };

  /**
   * Средний балл за четверть:
   * Оценки среднего балла считаются по оценкам за данную четверть (исключая предметы по полугодиям).
   * Сначала средний балл каждого четвертного предмета за четверть округляется до целого,
   * а затем вычисляется среднее арифметическое по этим округлённым оценкам.
   */
  function computeQuarterGpa(quarterId) {
    const quarterRows = rows.filter((r) => !semesterSubjects.has(r.subject));
    const targetRows = quarterRows;

    const roundedSubjectGrades = targetRows
      .map((r) => {
        const idx = rows.indexOf(r);
        const qAvg = quarterAvg(getEffRow(idx).list, quarterId);
        return qAvg !== null ? Math.round(qAvg) : null;
      })
      .filter((v) => v !== null);

    return average(roundedSubjectGrades);
  }

  /**
   * Средний балл за полугодие:
   * Считается по предметам, выбранным как «по полугодиям».
   * Сначала средний балл каждого полугодового предмета округляется до целого,
   * а затем вычисляется среднее арифметическое по ним.
   */
  function computeSemesterAvg(quarterId) {
    const sel = rows.filter((r) => semesterSubjects.has(r.subject));
    const roundedGrades = sel.map((r) => {
      const list = getEffRow(rows.indexOf(r)).list;
      const values = periodMarks(list, r.subject, quarterId).map((o) => o.v);
      const avg = average(values);
      return avg !== null ? Math.round(avg) : null;
    }).filter((v) => v !== null);
    return average(roundedGrades);
  }

  /** «Текущая» четверть — последняя, в которой уже есть оценки. */
  const currentQuarter = [...quarters]
    .reverse()
    .find((q) => allMarks.some((o) => o.q === q.id)) || quarters[0];

  let activeQuarterId = currentQuarter ? currentQuarter.id : null;
  const shownQuarter = () => quarters.find((q) => q.id === activeQuarterId) || currentQuarter;
  const semesterQuarters = (quarterId) => {
    const index = quarters.findIndex((q) => q.id === quarterId);
    return index < 0 ? [] : quarters.slice(Math.floor(index / 2) * 2, Math.floor(index / 2) * 2 + 2);
  };
  const semesterName = (quarterId) => (Math.floor(quarters.findIndex((q) => q.id === quarterId) / 2) + 1) + ' полугодие';
  const periodMarks = (list, subject, quarterId) => {
    if (!quarterId) return list;
    const ids = semesterSubjects.has(subject) ? semesterQuarters(quarterId).map((q) => q.id) : [quarterId];
    return list.filter((o) => ids.includes(o.q));
  };
  const markScope = (list, subject) => periodMarks(list, subject, activeQuarterId);
  const fmtOrDash = (value) => value == null ? '—' : fmt(value);

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
  function visibleRowsByAvg() {
    return rows.map((r, index) => ({
      subject: r.subject,
      avg: average(markScope(getEffRow(index).list, r.subject).map((m) => m.v)),
    })).filter((r) => r.avg !== null).sort((a, b) => b.avg - a.avg);
  }

  function renderSubjectsChart() {
    const displayRows = visibleRowsByAvg();
    if (!displayRows.length) return '<p class="note">В этой четверти пока нет текущих оценок.</p>';
    const W = 820, LEFT = 150, RIGHT = 60, TOP = 30, ROW_H = 32;
    const H = TOP + displayRows.length * ROW_H + 34;
    const x = (v) => LEFT + ((W - LEFT - RIGHT) * v) / 10;
    let svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px;font:13px sans-serif">`;
    for (let t = 0; t <= 10; t += 2) {
      svg += `<line x1="${x(t)}" x2="${x(t)}" y1="${TOP}" y2="${H - 30}" stroke="rgb(226,228,234)"/>
        <text x="${x(t)}" y="${H - 12}" text-anchor="middle" fill="rgb(120,125,140)">${t}</text>`;
    }
    displayRows.forEach((r, i) => {
      const y = TOP + i * ROW_H;
      svg += `<text x="${LEFT - 10}" y="${y + ROW_H / 2}" text-anchor="end" dominant-baseline="middle" fill="rgb(40,44,60)">${escapeHtml(r.subject)}</text>
        <rect x="${LEFT}" y="${y + 4}" width="${x(r.avg) - LEFT}" height="${ROW_H - 10}" rx="6" fill="${colorFor(r.avg)}"/>
        <text x="${x(r.avg) + 8}" y="${y + ROW_H / 2}" dominant-baseline="middle" font-weight="bold" fill="rgb(40,44,60)">${fmt(r.avg)}</text>`;
    });

    const targetQuarter = activeQuarterId ? shownQuarter() : currentQuarter;
    const quarterGpa = computeQuarterGpa(targetQuarter.id);
    if (quarterGpa !== null) {
      svg += `<line x1="${x(quarterGpa)}" x2="${x(quarterGpa)}" y1="${TOP - 8}" y2="${H - 30}" stroke="rgb(60,80,200)" stroke-dasharray="5 4" stroke-width="2"/>
        <text x="${x(quarterGpa)}" y="${TOP - 14}" text-anchor="middle" fill="rgb(60,80,200)" font-weight="bold">${escapeHtml(targetQuarter.name)} ${fmt(quarterGpa)}</text>`;
    }

    return svg + '</svg>';
  }

  function renderDistributionChart() {
    const W = 520, H = 240, LEFT = 14, BOTTOM = 34, TOP = 26;
    const counts = Array(11).fill(0);
    rows.forEach((r, i) => markScope(getEffRow(i).list, r.subject).forEach(({v}) => {
      if (v >= 0 && v <= 10) counts[v]++;
    }));
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
    const scoped = rows.flatMap((r, i) => markScope(getEffRow(i).list, r.subject));
    const all = scoped.map((o) => o.v);
    const averages = visibleRowsByAvg();
    const best = averages[0], worst = averages[averages.length - 1];

    const currentGpa = activeQuarterId
      ? computeQuarterGpa(activeQuarterId)
      : average(quarters.map((q) => computeQuarterGpa(q.id)).filter((v) => v !== null));

    const semesterPeriods = activeQuarterId ? [shownQuarter()] : quarters.filter((q, i) => i % 2 === 0);

    const kpis = [];

    if (activeQuarterId) {
      kpis.push(renderKpi(
        'Средний балл (' + escapeHtml(shownQuarter().name) + ')',
        fmtOrDash(currentGpa),
        all.length + ' текущих оценок',
        currentGpa === null ? 'rgb(236,237,243)' : colorFor(currentGpa, 0.55)
      ));
    } else {
      kpis.push(renderKpi(
        'Общий средний балл',
        fmtOrDash(currentGpa),
        all.length + ' текущих оценок',
        currentGpa === null ? 'rgb(236,237,243)' : colorFor(currentGpa, 0.55)
      ));
      for (const q of quarters) {
        const vals = rows.flatMap((r, i) => getEffRow(i).list.filter((o) => o.q === q.id).map((o) => o.v));
        const qGpa = computeQuarterGpa(q.id);
        kpis.push(renderKpi(
          escapeHtml(q.name),
          fmtOrDash(qGpa),
          vals.length + ' текущих оценок',
          qGpa === null ? 'rgb(236,237,243)' : colorFor(qGpa, 0.55)
        ));
      }
    }

    for (const q of semesterPeriods) {
      const semesterGpa = computeSemesterAvg(q.id);
      if (semesterGpa === null) continue;
      const semesterCount = rows.filter((r, i) => semesterSubjects.has(r.subject) &&
        periodMarks(getEffRow(i).list, r.subject, q.id).length).length;
      kpis.push(renderKpi(
        escapeHtml(semesterName(q.id)) + ' (расчёт)',
        fmt(semesterGpa),
        semesterCount + ' предм.',
        colorFor(semesterGpa, 0.55)
      ));
    }

    if (best) kpis.push(renderKpi('Лучший предмет', fmt(best.avg), escapeHtml(best.subject), colorFor(best.avg, 0.55)));
    if (worst) kpis.push(renderKpi('Слабейший предмет', fmt(worst.avg), escapeHtml(worst.subject), colorFor(worst.avg, 0.55)));
    return kpis.join('');
  }

  const avgCell = (x) =>
    x == null
      ? '<td class="mut">—</td>'
      : `<td style="background:${colorFor(x, 0.6)}"><b>${fmt(x)}</b></td>`;

  function renderSummaryTable() {
    const visibleQuarters = quarters.filter((q) => !activeQuarterId || q.id === activeQuarterId);
    const header = '<tr><th>Предмет</th>' +
      visibleQuarters.map((q) => `<th>${escapeHtml(q.name)}<span class="th-sub">Средний балл</span></th>`).join('') +
      (!activeQuarterId ? '<th>Общий средний</th>' : '') + '<th>Оценок</th></tr>';

    function summaryCell(r, i, q) {
      const mean = average(periodMarks(getEffRow(i).list, r.subject, q.id).map((o) => o.v));
      return `<td style="${mean == null ? '' : 'background:' + colorFor(mean, 0.82)}">` +
        `<div>${mean === null ? '<span class="mut">—</span>' : '<b>' + fmt(mean) + '</b> <span class="mut">(' + Math.round(mean) + ')</span>'}</div></td>`;
    }

    const body = rows.map((r, i) => {
      const vals = markScope(getEffRow(i).list, r.subject);
      const isSem = semesterSubjects.has(r.subject);
      const subjectQuarterGrades = quarters.filter((q, index) => !isSem || index % 2 === 0)
        .map((q) => {
          const m = average(periodMarks(getEffRow(i).list, r.subject, q.id).map((o) => o.v));
          return m !== null ? Math.round(m) : null;
        })
        .filter((x) => x !== null);
      const subjectOverall = average(subjectQuarterGrades);
      const semTag = isSem ? ' <span class="mut" style="font-size:11px;font-weight:normal">(полугодие)</span>' : '';

      return `<tr><td>${escapeHtml(r.subject)}${semTag}</td>` +
        visibleQuarters.map((q, index) => {
          if (!isSem || activeQuarterId) return summaryCell(r, i, q);
          if (index % 2) return '';
          return summaryCell(r, i, q).replace('<td ', '<td colspan="' + Math.min(2, visibleQuarters.length - index) + '" ');
        }).join('') +
        (!activeQuarterId ? avgCell(subjectOverall) : '') + `<td>${vals.length}</td></tr>`;
    }).join('');

    const total = rows.flatMap((r, i) => markScope(getEffRow(i).list, r.subject));
    const quarterGpas = quarters.map((q) => computeQuarterGpa(q.id)).filter((v) => v !== null);
    const overallGpa = average(quarterGpas);

    const foot = '<tr class="sum"><td>Все предметы</td>' +
      visibleQuarters.map((q) => `<td><b>${fmtOrDash(computeQuarterGpa(q.id))}</b></td>`).join('') +
      (!activeQuarterId ? avgCell(overallGpa) : '') +
      `<td>${total.length}</td></tr>`;

    return `<table class="tbl summary-table">${header}${body}${foot}</table>`;
  }

  const markChip = (v) => `<span class="m" style="background:${colorFor(v)}">${v}</span>`;

  /**
   * Запас, когда цель уже достигнута: какая самая низкая оценка допустима
   * и сколько оценок каждого достоинства ниже цели можно получить.
   */
  function buildReserveHtml(values, target, period) {
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
      `Запас: самая низкая оценка, после которой за ${period} всё ещё будет ${markChip(target)} — ${markChip(lowest)}. ` +
      `Сколько таких оценок можно получить (каждый вариант отдельно): ${list}. ` +
      `Оценки ${target} и выше не опасны.`
    );
  }

  /**
   * Подсказка под названием предмета: что нужно получить, чтобы за текущую
   * четверть стояла оценка `target`. Возвращает { ok, html }.
   */
  function buildTargetHint(row, target) {
    const q = shownQuarter();
    const isSem = semesterSubjects.has(row.subject);
    const qName = escapeHtml(isSem ? semesterName(q.id) : q.name);
    const period = isSem ? 'полугодие' : 'четверть';
    const values = periodMarks(row.list, row.subject, q.id).map((o) => o.v);

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
          `<div class="reserve">${buildReserveHtml(values, target, period)}</div>`,
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

  function renderTargetPicker(index, isSem) {
    const chosen = selectedTargets.get(index) || DEFAULT_TARGET;
    const buttons = TARGET_OPTIONS.map((t) =>
      `<button class="tg${t === chosen ? ' on' : ''}" data-i="${index}" data-t="${t}">${t}</button>`).join('');
    return `<div class="picker noprint"><span class="mut">Хочу за ${isSem ? 'полугодие' : 'четверть'}:</span>${buttons}</div>`;
  }

  function renderCard(row, index) {
    const effRow = getEffRow(index);
    const target = selectedTargets.get(index) || DEFAULT_TARGET;
    const hint = buildTargetHint(effRow, target);
    const val = average(markScope(effRow.list, row.subject).map((o) => o.v));
    const yearVal = average(effRow.list.map((o) => o.v));
    const shownAvg = activeQuarterId ? val : yearVal;
    const isSem = semesterSubjects.has(row.subject);
    const displayedQuarters = quarters.filter((q, i) => activeQuarterId
      ? (isSem ? semesterQuarters(activeQuarterId)[0].id === q.id : q.id === activeQuarterId)
      : (!isSem || i % 2 === 0));
    const quarterGroups = displayedQuarters.map((q) => {
      const entries = row.list.map((original, markIdx) => ({original, markIdx, value: overrides.get(index)?.has(markIdx) ? overrides.get(index).get(markIdx) : original.v}))
        .filter((entry) => periodMarks([entry.original], row.subject, q.id).length);
      if (!entries.length && !activeQuarterId) return '';
      const details = entries.map(({original, value, markIdx}) => {
        const removed = value === null;
        const changed = !removed && original.v !== value;
        return `<tr><td>${formatRuDate(original.date)}</td>
          <td>${original.n ? escapeHtml(original.n) + ' урок' : ''}</td>
          <td id="mc-${index}-${markIdx}"><span class="mark-edit">${changed ? `<span class="m-orig">${original.v}</span><span class="mark-arrow" aria-hidden="true">→</span>` : ''}
          <span class="m${changed ? ' m-changed' : ''}${removed ? ' m-removed' : ''}" data-card="${index}" data-mark="${markIdx}" data-orig="${original.v}" title="${removed ? 'Исключена из расчёта — нажмите, чтобы вернуть' : 'Изменить оценку'}" style="${removed ? '' : 'background:' + colorFor(value)}">${removed ? `<s>${original.v}</s> <span class="removed-label">убрана</span>` : value}</span></span></td></tr>`;
      }).join('');
      const qAvg = average(periodMarks(effRow.list, row.subject, q.id).map((o) => o.v));
      return `<tr class="head"><th colspan="3">${escapeHtml(isSem ? semesterName(q.id) : q.name)}</th></tr>` +
        (details || '<tr><td colspan="3" class="mut">Текущих оценок нет</td></tr>') +
        `<tr class="quarter-footer"><td colspan="3">Средний: <b>${fmtOrDash(qAvg)}</b>${qAvg !== null ? ` <span class="mut">(округлённый: <b>${Math.round(qAvg)}</b>)</span>` : ''}</td></tr>`;
    }).join('');
    const ov = overrides.get(index);
    const semBadge = isSem ? '<span class="badge" style="background:rgb(232,235,250);color:rgb(60,80,200);font-size:12px;margin-left:8px">по полугодиям</span>' : '';
    return `<div class="card" data-card="${index}">
      <h3><span>${escapeHtml(row.subject)}${semBadge}</span><span class="badge" style="${shownAvg == null ? 'background:rgb(230,232,240)' : 'background:' + colorFor(shownAvg)}">${fmtOrDash(shownAvg)}</span></h3>
      ${renderTargetPicker(index, isSem)}
      <div class="goal${hint.ok ? ' goal-ok' : ''}" id="goal-${index}">${hint.html}</div>
      <button class="reset-edit noprint" data-card="${index}" style="${ov && ov.size ? 'display:inline-block' : ''}">↺ сбросить правки</button>
      <table class="tbl"><tr><th>Дата</th><th>Урок</th><th>Оценка</th></tr>${quarterGroups || '<tr><td colspan="3" class="mut">Оценок пока нет</td></tr>'}
      ${activeQuarterId ? '' : `<tr class="sum"><td>За год</td><td>${effRow.list.length} оц.</td><td><b>${fmtOrDash(yearVal)}</b></td></tr>`}
      </table></div>`;
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
    .mark-edit { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
    .mark-arrow { color: rgb(120,125,140); }
    .m.m-removed { background: rgb(236,237,243); color: rgb(95,100,115); font-weight: 600; }
    .removed-label { font-size: 11px; }
    .m.m-changed { outline: 2px solid rgba(60,80,200,.55); outline-offset: 2px; }
    .m-orig { font-size: 10px; text-decoration: line-through; color: rgb(170,173,190); vertical-align: middle; }
    .edit-picker { position: fixed; background: white; border-radius: 12px; box-shadow: 0 4px 24px rgba(20,25,60,.22); padding: 10px; display: none; flex-wrap: wrap; gap: 5px; width: 195px; z-index: 9999; }
    .edit-picker.visible { display: flex; }
    .ep-label { width: 100%; font-size: 11px; color: rgb(120,125,140); margin-bottom: 2px; }
    .ep-btn { margin: 0; flex: 0 0 calc(20% - 4px); padding: 6px 0; border-radius: 8px; font-size: 13px; text-align: center; }
    .ep-remove { flex: 1 0 100%; padding: 6px; border-radius: 8px; font-size: 12px; background: rgb(255,238,236); color: rgb(150,45,40); }
    .ep-cancel { flex: 1 0 100%; margin-top: 4px; padding: 5px; border-radius: 8px; font-size: 12px; background: rgb(244,245,250); color: rgb(100,105,130); text-align: center; }
    .reset-edit { display: none; margin: 0 0 8px; padding: 4px 10px; border-radius: 8px; font-size: 12px; background: transparent; color: rgb(100,105,130); border: 1px solid rgb(215,218,230); }
    .reset-edit:hover { background: rgb(244,245,250); }
    .subj-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 4px; }
    .subj-item { display: flex; align-items: center; gap: 8px; padding: 5px 10px; border-radius: 8px; cursor: pointer; font-size: 14px; user-select: none; }
    .subj-item:hover { background: rgb(244,245,250); }
    .subj-check { margin: 0; width: 18px; height: 18px; cursor: pointer; accent-color: rgb(60,80,200); }
    .subj-name { flex: 1; }
    .subj-avg { display: inline-block; min-width: 24px; text-align: center; border-radius: 8px; padding: 1px 8px; font-weight: 700; color: white; font-size: 13px; }
    .sel-btn { margin: 0 6px 0 0; padding: 5px 14px; border-radius: 8px; font-size: 13px; background: rgb(232,235,250); color: rgb(60,80,200); font-weight: 600; }
    .period-tabs { display:flex; gap:8px; flex-wrap:wrap; margin:0 0 18px; }
    .period-tab { background:white; border:1px solid rgb(214,218,232); color:rgb(55,65,115); }
    .period-tab.active { background:rgb(60,80,200); color:white; }
    .th-sub { display:block; font-weight:400; font-size:11px; color:rgb(100,105,130); }
    .quarter-footer td { font-size:13px; background:rgb(250,250,253); }
    .summary-table { overflow-wrap:anywhere; }
    .summary-scroll { overflow-x:auto; }`;

  function renderPeriodTabs() {
    return `<nav class="period-tabs noprint" aria-label="Выбор четверти">` +
      [{id: null, name: 'Все четверти'}, ...quarters].map((q) =>
        `<button class="period-tab${activeQuarterId === q.id ? ' active' : ''}" data-quarter="${q.id || ''}">${escapeHtml(q.name)}</button>`).join('') + '</nav>';
  }

  function renderSubjectSelector() {
    const items = rows.map((r, i) => {
      const checked = semesterSubjects.has(r.subject) ? ' checked' : '';
      const eff = getEffRow(i);
      const avg = average(eff.list.map((o) => o.v));
      const rounded = avg !== null ? Math.round(avg) : null;
      return `<label class="subj-item">
        <input type="checkbox" class="subj-check" data-subject="${escapeHtml(r.subject)}"${checked}>
        <span class="subj-name">${escapeHtml(r.subject)}</span>
        <span class="subj-avg" style="background:${rounded === null ? 'rgb(185,190,203)' : colorFor(rounded)}">${rounded === null ? '—' : rounded}</span>
      </label>`;
    }).join('');

    return `
      <div class="panel noprint" id="subject-selector">
        <h2>Предметы с оценкой по полугодиям</h2>
        <p class="note" style="margin-bottom:10px">
          Отметь предметы, по которым оценки ставятся за полугодие (а не за четверть). Они не учитываются при расчёте среднего балла за четверть, а их оценка за полугодие рассчитывается отдельно. Выбор сохраняется автоматически.
        </p>
        <div style="margin-bottom:10px">
          <button class="sel-btn" id="sel-all">Выбрать все</button>
          <button class="sel-btn" id="sel-none">Снять все</button>
        </div>
        <div class="subj-grid">${items}</div>
      </div>`;
  }

  function renderReport() {
    const failedWarning = failedCount
      ? `<p style="color:rgb(200,30,30)">Не загрузилось недель: ${failedCount} — часть текущих оценок может отсутствовать</p>` : '';
    const duplicateWarning = crossQuarterDuplicates
      ? `<p style="color:rgb(165,95,10)">Внимание: ${crossQuarterDuplicates} оценок обнаружены на страницах разных четвертей. Проверь распределение по четвертям в дневнике.</p>` : '';
    return `<meta charset="utf-8"><title>Оценки ${todayStamp}</title><style>${REPORT_CSS}</style>
      <div class="wrap">
        <div class="top"><h1>Оценки</h1><div class="noprint"><button id="pr">Сохранить в PDF</button></div></div>
        <p class="hint noprint">Для PDF выбери в окне печати «Сохранить как PDF».</p>
        <div id="period-tabs">${renderPeriodTabs()}</div>
        <div class="kpis" id="kpis-container">${renderKpis()}</div>
        ${failedWarning}
        ${duplicateWarning}
        ${renderSubjectSelector()}
        <div class="panel" id="chart-container"><h2>Средний балл по предметам</h2>${renderSubjectsChart()}</div>
        <div class="panel" id="dist-container"><h2>Распределение оценок</h2>${renderDistributionChart()}</div>
        <div class="panel" id="summary-container"><h2>Сводка по четвертям</h2><div class="summary-scroll">${renderSummaryTable()}</div></div>
        <h2 id="cards-heading">${activeQuarterId ? escapeHtml(shownQuarter().name) : 'Все оценки по предметам'}</h2>
        <p class="note">Целевые оценки и «запас» — прогноз по среднему баллу. В режиме «Все четверти» прогноз строится для ${escapeHtml(currentQuarter.name)}.</p>
        <div class="grid" id="cards-container">${rows.map((r, i) => renderCard(r, i)).join('')}</div>
        <p class="note">Проверка: повторяющихся таблиц дней — ${duplicateTables}, отличающихся — ${differingDuplicates} (выбрана последняя копия).</p>
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
      list: row.list.map((o, mi) => ov.has(mi) ? { ...o, v: ov.get(mi) } : o).filter((o) => o.v !== null),
    };
  }

  /** Обновляет все показатели после переключения четверти или замены оценки. */
  function updateDashboard() {
    win.document.getElementById('period-tabs').innerHTML = renderPeriodTabs();
    win.document.getElementById('kpis-container').innerHTML = renderKpis();
    win.document.getElementById('chart-container').innerHTML = '<h2>Средний балл по предметам</h2>' + renderSubjectsChart();
    win.document.getElementById('dist-container').innerHTML = '<h2>Распределение оценок</h2>' + renderDistributionChart();
    win.document.getElementById('summary-container').innerHTML = '<h2>Сводка по четвертям</h2><div class="summary-scroll">' + renderSummaryTable() + '</div>';
    win.document.getElementById('cards-container').innerHTML = rows.map((r, i) => renderCard(r, i)).join('');
    win.document.getElementById('cards-heading').textContent = activeQuarterId ? shownQuarter().name : 'Все оценки по предметам';
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
    '<button class="ep-remove">Убрать из расчёта</button>' +
    '<button class="ep-cancel">Отмена</button>';
  win.document.body.appendChild(editPicker);

  let pickerTarget = null; // { cardIdx, markIdx, span }

  function showEditPicker(span) {
    pickerTarget = { cardIdx: +span.dataset.card, markIdx: +span.dataset.mark, span };
    const rect = span.getBoundingClientRect();
    editPicker.classList.add('visible');
    const pickerRect = editPicker.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, win.innerWidth - pickerRect.width - 8));
    const top = rect.bottom + 6 + pickerRect.height <= win.innerHeight
      ? rect.bottom + 6 : Math.max(8, rect.top - pickerRect.height - 6);
    editPicker.style.left = left + 'px';
    editPicker.style.top = top + 'px';
  }

  function hideEditPicker() {
    editPicker.classList.remove('visible');
    pickerTarget = null;
  }

  win.document.addEventListener('click', (event) => {
    const markSpan = event.target.closest && event.target.closest('.m[data-mark]');
    const tg       = !markSpan && event.target.closest && event.target.closest('.tg');
    const epBtn    = event.target.closest && event.target.closest('.ep-btn');
    const epCancel = event.target.closest && event.target.closest('.ep-cancel');
    const epRemove = event.target.closest && event.target.closest('.ep-remove');
    const resetBtn = event.target.closest && event.target.closest('.reset-edit');
    const periodBtn = event.target.closest && event.target.closest('.period-tab');
    const selectAllBtn = event.target.closest && event.target.closest('#sel-all');
    const selectNoneBtn = event.target.closest && event.target.closest('#sel-none');

    if (periodBtn) {
      activeQuarterId = periodBtn.dataset.quarter || null;
      hideEditPicker();
      updateDashboard();
      return;
    }

    if (selectAllBtn || selectNoneBtn) {
      if (selectAllBtn) rows.forEach((r) => semesterSubjects.add(r.subject));
      else semesterSubjects.clear();
      win.document.querySelectorAll('.subj-check').forEach((cb) => { cb.checked = !!selectAllBtn; });
      saveSemesterSubjects(semesterSubjects);
      updateDashboard();
      return;
    }

    // Закрываем пикер при клике вне него
    if (!editPicker.contains(event.target) && !markSpan) hideEditPicker();

    // Клик по оценке → открыть / закрыть пикер
    if (markSpan) {
      if (pickerTarget && pickerTarget.span === markSpan) { hideEditPicker(); return; }
      showEditPicker(markSpan);
      return;
    }

    // Выбор новой оценки из пикера
    if ((epBtn || epRemove) && pickerTarget) {
      const { cardIdx, markIdx, span } = pickerTarget;
      const newVal  = epRemove ? null : +epBtn.dataset.v;
      const origVal = +span.dataset.orig;

      if (!overrides.has(cardIdx)) overrides.set(cardIdx, new Map());
      if (newVal === origVal) {
        overrides.get(cardIdx).delete(markIdx);
      } else {
        overrides.get(cardIdx).set(markIdx, newVal);
      }

      hideEditPicker();
      updateDashboard();
      return;
    }

    if (epCancel) { hideEditPicker(); return; }

    // Сброс всех правок карточки
    if (resetBtn) {
      const cardIdx = +resetBtn.dataset.card;
      overrides.delete(cardIdx);
      updateDashboard();
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

      selectedTargets.set(index, target);
      tg.parentElement.querySelectorAll('.tg').forEach((b) => b.classList.toggle('on', b === tg));
    }
  });

  win.document.addEventListener('change', (event) => {
    if (event.target.classList.contains('subj-check')) {
      const subject = event.target.dataset.subject;
      if (event.target.checked) semesterSubjects.add(subject);
      else semesterSubjects.delete(subject);
      saveSemesterSubjects(semesterSubjects);
      updateDashboard();
    }
  });

  win.document.getElementById('pr').onclick = () => {
    win.focus();
    win.print();
  };
})();
