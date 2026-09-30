/*
 * Planning Nounou — app logic.
 * Vanilla JS, no external dependencies. Works as a local file (Mac Finder
 * double-click) or served from any static web server; also runs the
 * claude.ai Artifact integration when that host is present.
 */
(function(){
  "use strict";

  var MONTHS_FR = ["janvier","février","mars","avril","mai","juin","juillet","août","septembre","octobre","novembre","décembre"];
  var WEEKDAYS_FR = ["lundi","mardi","mercredi","jeudi","vendredi","samedi","dimanche"];
  var STORAGE_KEY = "nounou-planning-state-v1";
  var DATA_PATH = "data/state.json";

  function pad(n){ return String(n).padStart(2,"0"); }
  function monthKey(y,m){ return y + "-" + pad(m+1); } // m: 0-11
  function dayKeyOf(y,m,d){ return y + "-" + pad(m+1) + "-" + pad(d); }

  var DEFAULT_MUTED_WEEKDAYS = [1, 2, 5, 6]; // mardi, mercredi, samedi, dimanche (0 = lundi)

  function defaultState(){
    return {
      nanny: "",
      mutedWeekdays: DEFAULT_MUTED_WEEKDAYS.slice(),
      lastSettings: {
        matin: { start: "06:45", end: "08:30" },
        soir: { start: "16:45", end: "20:15" },
        rate: 15
      },
      months: {}
    };
  }

  function normalizeState(s){
    if(!s) return defaultState();
    if(typeof s.nanny !== "string") s.nanny = "";
    if(!Array.isArray(s.mutedWeekdays)) s.mutedWeekdays = DEFAULT_MUTED_WEEKDAYS.slice();
    if(!s.lastSettings) s.lastSettings = defaultState().lastSettings;
    if(!s.months) s.months = {};
    return s;
  }

  var state = null;
  var artifactAPI = null;
  var settingsSaveTimer = null;

  var view = (function(){
    var now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  })();

  var uiSettingsOpen = false;
  var confirmPay = false;
  var confirmUnlock = false;
  var editingDay = null; // dayKey string, or null when the day editor is closed
  var silentEdit = false; // "modification silencieuse" checkbox state for the open day editor

  // ---------- time helpers ----------
  function minutesOf(hhmm){
    if(!hhmm) return 0;
    var parts = hhmm.split(":");
    return (parseInt(parts[0],10)||0) * 60 + (parseInt(parts[1],10)||0);
  }
  function rangeMinutes(range){
    if(!range || !range.start || !range.end) return 0;
    var diff = minutesOf(range.end) - minutesOf(range.start);
    if(diff <= 0) diff += 24*60;
    return diff;
  }
  function fmtHM(totalMinutes){
    totalMinutes = Math.round(totalMinutes);
    var h = Math.floor(totalMinutes/60);
    var m = totalMinutes % 60;
    if(m === 0) return h + "h";
    return h + "h" + pad(m);
  }
  function fmtEUR(value){
    try{
      return new Intl.NumberFormat("fr-FR", { style:"currency", currency:"EUR" }).format(value);
    }catch(e){
      return value.toFixed(2).replace(".", ",") + " €";
    }
  }
  function fmtDateShort(dateObj){
    return pad(dateObj.getDate()) + "/" + pad(dateObj.getMonth()+1) + "/" + dateObj.getFullYear();
  }
  function fmtDateTimeFR(iso){
    var d = new Date(iso);
    if(isNaN(d.getTime())) return "";
    return fmtDateShort(d) + " à " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function escapeHtml(s){
    return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  // ---------- state / month access ----------
  function normalizeMonth(md){
    if(typeof md.observations !== "string") md.observations = "";
    if(typeof md.adjustment !== "number" || isNaN(md.adjustment)) md.adjustment = 0;
    return md;
  }

  function ensureMonth(key){
    if(!state.months[key]){
      var tpl = state.lastSettings;
      state.months[key] = {
        matin: { start: tpl.matin.start, end: tpl.matin.end },
        soir: { start: tpl.soir.start, end: tpl.soir.end },
        rate: tpl.rate,
        days: {},
        paid: null,
        observations: "",
        adjustment: 0
      };
    }
    return normalizeMonth(state.months[key]);
  }

  function effectiveRange(md, dayState, shift){
    return (dayState && dayState[shift + "Time"]) || md[shift];
  }

  function cleanupDay(md, dk){
    var d = md.days[dk];
    if(d && !d.matin && !d.soir) delete md.days[dk];
  }

  // A day counts as "past" once its calendar date is strictly before today —
  // used to flag edits made after the fact. String comparison works because
  // day keys are zero-padded "YYYY-MM-DD".
  function isPastDate(dk){
    var now = new Date();
    var todayKey = dayKeyOf(now.getFullYear(), now.getMonth(), now.getDate());
    return dk < todayKey;
  }

  // Flags (or clears, when silent) the "modified after the fact" marker on a
  // day that has already passed. No-op for today/future days — there is
  // nothing retroactive about editing those.
  function markDayEdited(md, dk, silent){
    if(!md.days[dk]) return;
    if(isPastDate(dk)) md.days[dk].modifiedAfterFact = !silent;
  }

  function dayTotalMinutes(md, dk){
    var d = md.days[dk];
    if(!d || d.cancelled) return 0;
    var total = 0;
    if(d.matin) total += rangeMinutes(effectiveRange(md, d, "matin"));
    if(d.soir) total += rangeMinutes(effectiveRange(md, d, "soir"));
    return total;
  }

  function monthTotalMinutes(md){
    var total = 0;
    for(var dk in md.days){
      if(Object.prototype.hasOwnProperty.call(md.days, dk)) total += dayTotalMinutes(md, dk);
    }
    return total;
  }

  // Hours-based total plus the free-form monthly adjustment (can be negative).
  function monthTotalPrice(md, totalMin){
    var base = (totalMin / 60) * md.rate;
    return base + (md.adjustment || 0);
  }

  // ---------- persistence ----------
  function persistLocal(){
    try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }catch(e){}
  }

  function setSaveNote(text){
    var el = document.getElementById("save-note");
    if(el) el.textContent = text;
  }

  function publishState(){
    persistLocal();
    if(!artifactAPI) return;
    var payload = JSON.stringify(state, null, 2);
    artifactAPI.publish({ "data/state.json": payload }).then(function(){
      setSaveNote("Enregistré à " + pad(new Date().getHours()) + ":" + pad(new Date().getMinutes()));
    }).catch(function(err){
      if(err && err.code === "conflict"){
        fetchRemoteState().then(function(fresh){
          if(fresh){ state = normalizeState(fresh); render(); setSaveNote("Synchronisé depuis un autre onglet"); }
        });
      } else if(err && (err.code === "not_granted" || err.code === "not_writer" || err.code === "capability_disabled" || err.code === "not_declared" || err.code === "capability_removed")){
        artifactAPI = null;
        setSaveNote("Enregistré sur cet appareil");
      } else {
        setSaveNote("Sauvegarde locale (hors ligne)");
      }
    });
  }

  function fetchRemoteState(){
    return fetch(DATA_PATH, { cache: "no-store" }).then(function(res){
      if(!res.ok) return null;
      return res.json();
    }).catch(function(){ return null; });
  }

  function loadLocalState(){
    try{
      var raw = localStorage.getItem(STORAGE_KEY);
      if(raw) return JSON.parse(raw);
    }catch(e){}
    return null;
  }

  // ---------- minimal PDF generator (no external libraries; standard-14 fonts + WinAnsi only) ----------
  var PDF_SPECIAL = {
    "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85,
    "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8A,
    "‹": 0x8B, "Œ": 0x8C, "Ž": 0x8E, "‘": 0x91, "’": 0x92,
    "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97,
    "˜": 0x98, "™": 0x99, "š": 0x9A, "›": 0x9B, "œ": 0x9C,
    "ž": 0x9E, "Ÿ": 0x9F
  };
  function winAnsiBytes(str){
    var out = [];
    for(var i = 0; i < str.length; i++){
      var ch = str[i];
      var code = str.charCodeAt(i);
      if(PDF_SPECIAL[ch] !== undefined) out.push(PDF_SPECIAL[ch]);
      else if(code <= 0xFF) out.push(code);
      else out.push(0x3F); // '?' fallback for anything outside Latin-1/WinAnsi
    }
    return out;
  }

  function PdfWriter(){ this.chunks = []; this.length = 0; }
  PdfWriter.prototype.ascii = function(s){
    var b = new Uint8Array(s.length);
    for(var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xFF;
    this.chunks.push(b); this.length += b.length;
  };
  PdfWriter.prototype.bytes = function(arr){
    var b = new Uint8Array(arr);
    this.chunks.push(b); this.length += b.length;
  };
  PdfWriter.prototype.offset = function(){ return this.length; };
  PdfWriter.prototype.toUint8Array = function(){
    var out = new Uint8Array(this.length), pos = 0;
    for(var i = 0; i < this.chunks.length; i++){ out.set(this.chunks[i], pos); pos += this.chunks[i].length; }
    return out;
  };

  function ContentBuilder(){ this.bytes = []; }
  ContentBuilder.prototype.raw = function(s){
    for(var i = 0; i < s.length; i++) this.bytes.push(s.charCodeAt(i) & 0xFF);
  };
  ContentBuilder.prototype.str = function(s){
    this.bytes.push(0x28);
    var enc = winAnsiBytes(s);
    for(var i = 0; i < enc.length; i++){
      var b = enc[i];
      if(b === 0x28 || b === 0x29 || b === 0x5C) this.bytes.push(0x5C);
      this.bytes.push(b);
    }
    this.bytes.push(0x29);
  };
  ContentBuilder.prototype.fillRect = function(x, y, w, h, r, g, b){
    this.raw(r + " " + g + " " + b + " rg\n");
    this.raw(x + " " + y + " " + w + " " + h + " re f\n");
  };
  ContentBuilder.prototype.line = function(x1, y1, x2, y2){
    this.raw(x1 + " " + y1 + " m " + x2 + " " + y2 + " l S\n");
  };
  ContentBuilder.prototype.text = function(s, x, y, font, size, r, g, b){
    // Always pin the fill color for text explicitly (defaults to black) — the
    // graphics state is shared with row-highlight fills, so without this a
    // text draw right after a colored fillRect would inherit that color.
    this.raw((r == null ? 0 : r) + " " + (g == null ? 0 : g) + " " + (b == null ? 0 : b) + " rg\n");
    this.raw("BT\n/" + font + " " + size + " Tf\n1 0 0 1 " + x + " " + y + " Tm\n");
    this.str(s);
    this.raw(" Tj\nET\n");
  };
  function courierWidth(s, size){ return s.length * size * 0.6; }
  function pad10(n){ var s = String(Math.round(n)); while(s.length < 10) s = "0" + s; return s; }

  // Simple monospace (Courier) word-wrap: exact because courierWidth is an
  // exact per-character metric, unlike the proportional Helvetica faces.
  function wrapMonospace(text, maxWidth, size){
    var charW = size * 0.6;
    var maxChars = Math.max(10, Math.floor(maxWidth / charW));
    var paragraphs = String(text).replace(/\r\n/g, "\n").split("\n");
    var lines = [];
    paragraphs.forEach(function(p){
      if(p === ""){ lines.push(""); return; }
      var words = p.split(/\s+/).filter(Boolean);
      var cur = "";
      words.forEach(function(w){
        while(w.length > maxChars){
          if(cur){ lines.push(cur); cur = ""; }
          lines.push(w.slice(0, maxChars));
          w = w.slice(maxChars);
        }
        var candidate = cur ? (cur + " " + w) : w;
        if(candidate.length > maxChars){
          if(cur) lines.push(cur);
          cur = w;
        } else {
          cur = candidate;
        }
      });
      if(cur) lines.push(cur);
    });
    return lines;
  }

  function buildPlanningPdf(viewYear, viewMonth, md, totalMin, totalPrice){
    var daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    // Exact A4 (210 x 297 mm). A page of 595 x 842 pt is 209.9 x 297.2 mm, which
    // some print drivers classify as a custom size and then crop or re-centre
    // instead of mapping it onto the A4 sheet.
    var PW = 595.276, PH = 841.89;
    var marginL = 36, tableWidth = 523;
    var colX = [36, 94, 176, 316, 456, 559];
    var headerH = 20, rowH = 17;

    var hasObs = !!(md.observations && md.observations.trim());
    var obsLines = [];
    if(hasObs){
      obsLines = wrapMonospace(md.observations.trim(), tableWidth, 8.5);
      var MAX_OBS_LINES = 6;
      if(obsLines.length > MAX_OBS_LINES){
        obsLines = obsLines.slice(0, MAX_OBS_LINES);
        var lastIdx = MAX_OBS_LINES - 1;
        obsLines[lastIdx] = obsLines[lastIdx].replace(/.$/, "…");
      }
    }
    var obsBlockH = hasObs ? (20 + obsLines.length * 11 + 16) : 0;

    // The whole block (title, table, totals, observations, edition date) is
    // centred vertically so that every month keeps a generous margin top and
    // bottom. The previous layout pinned the title 15 mm from the top edge and
    // left 5 cm blank at the bottom, so any printer that loses a strip at the
    // top ate the title first.
    var blockHeight = 12 + 40 + headerH + rowH * daysInMonth + 22 + 24 + obsBlockH;
    var titleY = Math.round((PH + blockHeight) / 2) - 12;
    var tableTop = titleY - 40;

    var cb = new ContentBuilder();

    var nannyLabel = state.nanny ? (" — " + state.nanny) : "";
    cb.text("Planning de garde" + nannyLabel, marginL, titleY, "F2", 16);
    var subtitle = capitalize(MONTHS_FR[viewMonth]) + " " + viewYear +
      "  ·  Matin " + md.matin.start + "–" + md.matin.end +
      "  ·  Soir " + md.soir.start + "–" + md.soir.end +
      "  ·  Taux horaire " + fmtEUR(md.rate) + "/h";
    cb.text(subtitle, marginL, titleY - 19, "F1", 10);

    // legend swatch
    cb.fillRect(430, titleY - 7, 10, 10, 0.953, 0.894, 0.788);
    cb.text("Jour travaillé", 444, titleY - 6, "F1", 9);

    // header fill
    cb.fillRect(marginL, tableTop - headerH, tableWidth, headerH, 0.918, 0.906, 0.863);

    // per-row highlight fills for worked days
    var rowTops = [tableTop, tableTop - headerH];
    var y = tableTop - headerH;
    var rows = [];
    for(var d = 1; d <= daysInMonth; d++){
      var cellDate = new Date(viewYear, viewMonth, d);
      var dk = dayKeyOf(viewYear, viewMonth, d);
      var dayState = md.days[dk] || { matin:false, soir:false };
      var total = dayTotalMinutes(md, dk);
      var cancelled = !!dayState.cancelled;
      var weekdayIdx = (cellDate.getDay() + 6) % 7;
      if(cancelled) cb.fillRect(marginL, y - rowH, tableWidth, rowH, 0.973, 0.867, 0.851);
      else if(total > 0) cb.fillRect(marginL, y - rowH, tableWidth, rowH, 0.953, 0.894, 0.788);
      rows.push({ d:d, weekdayIdx:weekdayIdx, dayState:dayState, total:total, cancelled:cancelled,
        matinRange: effectiveRange(md, dayState, "matin"), soirRange: effectiveRange(md, dayState, "soir") });
      y -= rowH;
      rowTops.push(y);
    }
    var tableBottom = y;

    // grid lines (drawn after fills so they stay crisp on top)
    cb.raw("0 0 0 RG\n0.75 w\n");
    for(var i = 0; i < rowTops.length; i++) cb.line(marginL, rowTops[i], marginL + tableWidth, rowTops[i]);
    for(var c = 0; c < colX.length; c++) cb.line(colX[c], tableTop, colX[c], tableBottom);

    // header labels
    var hy = tableTop - 14;
    cb.text("Date", colX[1] - 6 - courierWidth("Date", 9), hy, "F4", 9);
    cb.text("Jour", colX[1] + 6, hy, "F2", 9);
    cb.text("Matin", colX[2] + 6, hy, "F2", 9);
    cb.text("Soir", colX[3] + 6, hy, "F2", 9);
    cb.text("Heures", colX[5] - 6 - courierWidth("Heures", 9), hy, "F4", 9);

    // body rows
    for(var k = 0; k < rows.length; k++){
      var row = rows[k];
      var rowTop = rowTops[k + 1];
      var by = rowTop - 12;
      var dateStr = pad(row.d) + "/" + pad(viewMonth + 1);
      var matinStr = row.dayState.matin ? (row.matinRange.start + "–" + row.matinRange.end) : "–";
      var soirStr = row.dayState.soir ? (row.soirRange.start + "–" + row.soirRange.end) : "–";
      var heuresStr = row.cancelled ? "Annulé" : (row.total > 0 ? fmtHM(row.total) : "—");

      cb.text(dateStr, colX[1] - 6 - courierWidth(dateStr, 8.5), by, "F3", 8.5);
      cb.text(capitalize(WEEKDAYS_FR[row.weekdayIdx]), colX[1] + 6, by, "F1", 8.5);
      cb.text(matinStr, colX[2] + 6, by, "F1", 8.5);
      cb.text(soirStr, colX[3] + 6, by, "F1", 8.5);
      cb.text(heuresStr, colX[5] - 6 - courierWidth(heuresStr, 8.5), by, "F3", 8.5);
    }

    // footer summary
    var statusLine = md.paid ? ("Payé le " + fmtDateTimeFR(md.paid.date)) : "Non payé";
    var footerY = tableBottom - 22;
    cb.raw("0.6 w\n");
    cb.line(marginL, footerY + 14, marginL + tableWidth, footerY + 14);
    var summary = "Total heures : " + (totalMin > 0 ? fmtHM(totalMin) : "0h") +
      "      Total à payer : " + fmtEUR(totalPrice) +
      "      Statut : " + statusLine;
    if(md.adjustment){
      summary += "      Ajustement : " + (md.adjustment > 0 ? "+" : "") + fmtEUR(md.adjustment);
    }
    cb.text(summary, marginL, footerY, "F2", 10.5);

    var afterFooterY = footerY;
    if(hasObs){
      afterFooterY = footerY - 20;
      cb.text("Observations :", marginL, afterFooterY, "F2", 9);
      for(var oi2 = 0; oi2 < obsLines.length; oi2++){
        cb.text(obsLines[oi2], marginL, afterFooterY - 12 - oi2 * 11, "F3", 8.5);
      }
      afterFooterY = afterFooterY - 12 - obsLines.length * 11;
    }
    // Right under the totals rather than pinned to the bottom edge: keeps every
    // printed element inside the safe area of the sheet.
    cb.text("Édité le " + fmtDateShort(new Date()), marginL, afterFooterY - 14, "F1", 8);

    var contentBytes = cb.bytes;

    var writer = new PdfWriter();
    writer.ascii("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
    var offsets = [0];
    function beginObj(n){ offsets[n] = writer.offset(); writer.ascii(n + " 0 obj\n"); }
    function endObj(){ writer.ascii("endobj\n"); }

    beginObj(1); writer.ascii("<< /Type /Catalog /Pages 2 0 R >>\n"); endObj();
    beginObj(2); writer.ascii("<< /Type /Pages /Kids [3 0 R] /Count 1 >>\n"); endObj();
    beginObj(3); writer.ascii("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + PW + " " + PH + "] /Resources << /Font << /F1 4 0 R /F2 5 0 R /F3 6 0 R /F4 7 0 R >> >> /Contents 8 0 R >>\n"); endObj();
    beginObj(4); writer.ascii("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\n"); endObj();
    beginObj(5); writer.ascii("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\n"); endObj();
    beginObj(6); writer.ascii("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>\n"); endObj();
    beginObj(7); writer.ascii("<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>\n"); endObj();
    beginObj(8);
    writer.ascii("<< /Length " + contentBytes.length + " >>\nstream\n");
    writer.bytes(contentBytes);
    writer.ascii("\nendstream\n");
    endObj();

    var xrefOffset = writer.offset();
    writer.ascii("xref\n0 9\n0000000000 65535 f \n");
    for(var oi = 1; oi <= 8; oi++) writer.ascii(pad10(offsets[oi]) + " 00000 n \n");
    writer.ascii("trailer\n<< /Size 9 /Root 1 0 R >>\nstartxref\n" + xrefOffset + "\n%%EOF");

    return writer.toUint8Array();
  }

  function pdfFilename(){
    var slug = MONTHS_FR[view.month];
    try{ slug = slug.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }catch(e){}
    return "planning-nounou-" + slug + "-" + view.year + ".pdf";
  }

  // Native browser download (Blob + temporary <a download>). This is blocked
  // inside the sandboxed claude.ai artifact viewer (hence the "downloads"
  // capability above), but works normally everywhere else — a local file
  // opened on a Mac, any regular web server, any other browser context.
  function triggerBrowserDownload(bytes, filename, mime){
    try{
      var blob = new Blob([bytes], { type: mime || "application/pdf" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function(){ URL.revokeObjectURL(url); }, 4000);
      return true;
    }catch(e){
      return false;
    }
  }

  function exportPdf(){
    var key = monthKey(view.year, view.month);
    var md = ensureMonth(key);
    var totalMin = monthTotalMinutes(md);
    var totalPrice = monthTotalPrice(md, totalMin);
    var bytes;
    try{
      bytes = buildPlanningPdf(view.year, view.month, md, totalMin, totalPrice);
    }catch(e){
      setSaveNote("Erreur lors de la génération du PDF");
      window.print();
      return;
    }

    var filename = pdfFilename();
    var hasClaudeHost = (typeof window.claude !== "undefined" && window.claude && window.claude.use);

    function fallback(){
      if(triggerBrowserDownload(bytes, filename)) setSaveNote("PDF téléchargé");
      else window.print();
    }

    if(!hasClaudeHost){
      // Standalone page (opened directly, e.g. from the Finder on a Mac, or
      // served by any regular web server) — no claude.ai host to broker the
      // save, but nothing sandboxes a plain download either.
      fallback();
      return;
    }

    window.claude.use("downloads").then(function(downloadsAPI){
      if(!downloadsAPI){ fallback(); return; }
      return downloadsAPI.save({ filename: filename, data: bytes }).then(function(){
        setSaveNote("PDF téléchargé");
      }).catch(function(err){
        if(err && err.code === "declined") return;
        fallback();
      });
    }).catch(fallback);
  }

  // ---------- JSON backup / restore ----------
  function jsonBackupFilename(){
    var now = new Date();
    return "planning-nounou-sauvegarde-" + now.getFullYear() + "-" + pad(now.getMonth()+1) + "-" + pad(now.getDate()) + ".json";
  }

  function utf8Bytes(str){
    if(typeof TextEncoder !== "undefined") return new TextEncoder().encode(str);
    // Very old browsers: encodeURIComponent round-trip produces the same bytes.
    var esc = unescape(encodeURIComponent(str));
    var out = new Uint8Array(esc.length);
    for(var i = 0; i < esc.length; i++) out[i] = esc.charCodeAt(i) & 0xFF;
    return out;
  }

  function exportJson(){
    var payload = {
      _app: "planning-nounou",
      _exportedAt: new Date().toISOString(),
      nanny: state.nanny,
      mutedWeekdays: state.mutedWeekdays,
      lastSettings: state.lastSettings,
      months: state.months
    };
    var text;
    try{
      text = JSON.stringify(payload, null, 2);
    }catch(e){
      setSaveNote("Erreur lors de la préparation du fichier");
      return;
    }
    var bytes = utf8Bytes(text);
    var filename = jsonBackupFilename();
    var hasClaudeHost = (typeof window.claude !== "undefined" && window.claude && window.claude.use);

    function fallback(){
      if(triggerBrowserDownload(bytes, filename, "application/json")) setSaveNote("Sauvegarde JSON téléchargée");
      else setSaveNote("Téléchargement impossible sur cet appareil");
    }

    if(!hasClaudeHost){ fallback(); return; }

    window.claude.use("downloads").then(function(downloadsAPI){
      if(!downloadsAPI){ fallback(); return; }
      return downloadsAPI.save({ filename: filename, data: bytes }).then(function(){
        setSaveNote("Sauvegarde JSON téléchargée");
      }).catch(function(err){
        if(err && err.code === "declined") return;
        fallback();
      });
    }).catch(fallback);
  }

  // Basic shape check: we only accept a file that actually looks like a
  // planning export, so a wrong file picked by mistake cannot wipe the data.
  function looksLikePlanning(obj){
    if(!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
    var hasMonths = obj.months && typeof obj.months === "object" && !Array.isArray(obj.months);
    var hasSettings = obj.lastSettings && typeof obj.lastSettings === "object";
    return !!(hasMonths || hasSettings);
  }

  function monthCount(obj){
    var n = 0;
    if(obj && obj.months){
      for(var k in obj.months){ if(Object.prototype.hasOwnProperty.call(obj.months, k)) n++; }
    }
    return n;
  }

  function applyImportedState(parsed){
    var incoming = {
      nanny: parsed.nanny,
      mutedWeekdays: parsed.mutedWeekdays,
      lastSettings: parsed.lastSettings,
      months: parsed.months
    };
    state = normalizeState(incoming);
    uiSettingsOpen = false;
    confirmPay = false;
    confirmUnlock = false;
    editingDay = null;
    silentEdit = false;
    render();
    publishState();
    setSaveNote("Sauvegarde importée");
  }

  function importJsonFile(file){
    if(!file) return;
    var reader = new FileReader();
    reader.onerror = function(){ setSaveNote("Lecture du fichier impossible"); };
    reader.onload = function(){
      var parsed;
      try{
        parsed = JSON.parse(String(reader.result));
      }catch(e){
        setSaveNote("Fichier illisible : ce n'est pas un JSON valide");
        return;
      }
      if(!looksLikePlanning(parsed)){
        setSaveNote("Ce fichier n'est pas une sauvegarde du planning");
        return;
      }
      var current = monthCount(state);
      var incoming = monthCount(parsed);
      var msg = "Importer cette sauvegarde ?\n\n" +
        "Fichier : " + incoming + " mois enregistré" + (incoming > 1 ? "s" : "") + "\n" +
        "Actuel : " + current + " mois enregistré" + (current > 1 ? "s" : "") + "\n\n" +
        "Les données actuelles seront remplacées définitivement.";
      if(!window.confirm(msg)){
        setSaveNote("Import annulé");
        return;
      }
      applyImportedState(parsed);
    };
    reader.readAsText(file);
  }

  // ---------- rendering ----------
  function render(){
    var key = monthKey(view.year, view.month);
    var md = ensureMonth(key);
    var locked = !!md.paid;

    document.getElementById("nanny-name").value = state.nanny || "";
    document.getElementById("nanny-name").disabled = false;

    document.getElementById("month-title").textContent =
      capitalize(MONTHS_FR[view.month]) + " " + view.year;

    var now = new Date();
    var isCurrentRealMonth = (view.year === now.getFullYear() && view.month === now.getMonth());
    document.getElementById("today-jump").hidden = isCurrentRealMonth;

    // settings panel
    document.getElementById("settings-toggle").setAttribute("aria-pressed", String(uiSettingsOpen));
    var panel = document.getElementById("settings-panel");
    panel.hidden = !uiSettingsOpen;
    document.getElementById("matin-start").value = md.matin.start;
    document.getElementById("matin-end").value = md.matin.end;
    document.getElementById("soir-start").value = md.soir.start;
    document.getElementById("soir-end").value = md.soir.end;
    document.getElementById("rate-input").value = md.rate;
    document.getElementById("adjustment-input").value = md.adjustment;
    ["matin-start","matin-end","soir-start","soir-end","rate-input","adjustment-input"].forEach(function(id){
      document.getElementById(id).disabled = locked;
    });
    renderMutedWeekdayRow();

    // observations (always visible, not tucked behind the settings toggle)
    var obsEl = document.getElementById("month-observations");
    obsEl.value = md.observations || "";
    obsEl.disabled = locked;

    // stats
    var totalMin = monthTotalMinutes(md);
    var totalPrice = monthTotalPrice(md, totalMin);
    document.getElementById("stat-hours").textContent = totalMin > 0 ? fmtHM(totalMin) : "0h";
    document.getElementById("stat-price").textContent = fmtEUR(totalPrice);
    var subnoteEl = document.getElementById("stat-price-subnote");
    if(md.adjustment){
      subnoteEl.hidden = false;
      subnoteEl.textContent = "dont ajustement : " + (md.adjustment > 0 ? "+" : "") + fmtEUR(md.adjustment);
    } else {
      subnoteEl.hidden = true;
    }

    var statusEl = document.getElementById("stat-status");
    if(locked){
      statusEl.innerHTML = '<span class="badge-paid">' + lockIconSVG() + " Payé le " + fmtDateTimeFR(md.paid.date) + "</span>";
    } else {
      statusEl.innerHTML = '<span class="badge-unpaid">Non payé</span>';
    }

    renderActionRow(md, locked, totalPrice);
    renderCalendar(md, key, locked);
    renderPrintSheet(md, key, locked, totalMin, totalPrice);
    renderDayEditor(md, locked);
  }

  function capitalize(s){ return s.charAt(0).toUpperCase() + s.slice(1); }

  var WD_ABBR = ["lun.","mar.","mer.","jeu.","ven.","sam.","dim."];

  function renderMutedWeekdayRow(){
    var row = document.getElementById("muted-weekday-row");
    var html = "";
    for(var i = 0; i < 7; i++){
      var active = state.mutedWeekdays.indexOf(i) !== -1;
      html += '<button type="button" class="wd-toggle' + (active ? ' active' : '') + '" data-wd="' + i + '" aria-pressed="' + active + '">' + WD_ABBR[i] + '</button>';
    }
    row.innerHTML = html;
    row.querySelectorAll("[data-wd]").forEach(function(btn){
      btn.addEventListener("click", function(e){
        var idx = parseInt(e.currentTarget.getAttribute("data-wd"), 10);
        var pos = state.mutedWeekdays.indexOf(idx);
        if(pos === -1) state.mutedWeekdays.push(idx); else state.mutedWeekdays.splice(pos, 1);
        render();
        publishState();
      });
    });
  }

  function lockIconSVG(){
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
  }

  function renderActionRow(md, locked, totalPrice){
    var row = document.getElementById("action-row");
    var html = "";

    if(!locked){
      if(!confirmPay){
        html += '<button class="btn btn-primary" id="btn-pay" type="button">' + lockIconSVG() + " Marquer comme payé</button>";
      } else {
        html += '<button class="btn btn-confirm" id="btn-pay-confirm" type="button">Confirmer le paiement</button>';
        html += '<button class="link-quiet" id="btn-pay-cancel" type="button">Annuler</button>';
      }
    } else {
      if(!confirmUnlock){
        html += '<button class="link-quiet" id="btn-unlock" type="button">Déverrouiller ce mois</button>';
      } else {
        html += '<span style="font-size:12.5px;color:var(--ink-soft);">Retirer le paiement de ' + fmtEUR(totalPrice) + '&nbsp;?</span>';
        html += '<button class="link-quiet" id="btn-unlock-confirm" type="button">Oui, déverrouiller</button>';
        html += '<button class="link-quiet" id="btn-unlock-cancel" type="button">Non</button>';
      }
    }

    html += '<button class="btn btn-ghost" id="btn-pdf" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 15h1.5a1.5 1.5 0 0 0 0-3H9v5"/><path d="M13 12v5h1a2 2 0 0 0 2-2.5A2 2 0 0 0 14 12z"/></svg> Extraire en PDF</button>';

    html += '<span class="save-note" id="save-note"></span>';
    row.innerHTML = html;

    if(!locked){
      if(!confirmPay){
        document.getElementById("btn-pay").addEventListener("click", function(){ confirmPay = true; render(); });
      } else {
        document.getElementById("btn-pay-confirm").addEventListener("click", onConfirmPay);
        document.getElementById("btn-pay-cancel").addEventListener("click", function(){ confirmPay = false; render(); });
      }
    } else {
      if(!confirmUnlock){
        document.getElementById("btn-unlock").addEventListener("click", function(){ confirmUnlock = true; render(); });
      } else {
        document.getElementById("btn-unlock-confirm").addEventListener("click", onConfirmUnlock);
        document.getElementById("btn-unlock-cancel").addEventListener("click", function(){ confirmUnlock = false; render(); });
      }
    }
    document.getElementById("btn-pdf").addEventListener("click", exportPdf);
  }

  function onConfirmPay(){
    var key = monthKey(view.year, view.month);
    var md = ensureMonth(key);
    md.paid = { date: new Date().toISOString() };
    confirmPay = false;
    publishState();
    render();
  }
  function onConfirmUnlock(){
    var key = monthKey(view.year, view.month);
    var md = ensureMonth(key);
    md.paid = null;
    confirmUnlock = false;
    publishState();
    render();
  }

  function renderCalendar(md, key, locked){
    var grid = document.getElementById("cal-grid");
    var firstOfMonth = new Date(view.year, view.month, 1);
    var lead = (firstOfMonth.getDay() + 6) % 7; // 0 = Monday
    var daysInMonth = new Date(view.year, view.month + 1, 0).getDate();
    var totalCells = Math.ceil((lead + daysInMonth) / 7) * 7;

    var now = new Date();
    var todayKey = dayKeyOf(now.getFullYear(), now.getMonth(), now.getDate());

    var html = "";
    for(var i = 0; i < totalCells; i++){
      var cellDate = new Date(view.year, view.month, 1 - lead + i);
      var inMonth = cellDate.getMonth() === view.month;
      var dk = dayKeyOf(cellDate.getFullYear(), cellDate.getMonth(), cellDate.getDate());
      var isToday = dk === todayKey;

      if(!inMonth){
        html += '<div class="day-cell other-month"><div class="day-head"><span class="day-num">' + cellDate.getDate() + '</span></div></div>';
        continue;
      }

      var dayState = md.days[dk] || { matin:false, soir:false };
      var total = dayTotalMinutes(md, dk);
      var cancelled = !!dayState.cancelled;
      var retro = !!dayState.modifiedAfterFact;
      var weekdayIdx = (cellDate.getDay() + 6) % 7;
      var muted = state.mutedWeekdays.indexOf(weekdayIdx) !== -1;
      var matinRange = effectiveRange(md, dayState, "matin");
      var soirRange = effectiveRange(md, dayState, "soir");
      var hasPlan = !!(dayState.matin || dayState.soir);

      html += '<div class="day-cell' + (isToday ? ' is-today' : '') + (locked ? ' locked' : '') + (muted ? ' muted-day' : '') + (cancelled ? ' cancelled-day' : '') + '">';
      html += '<div class="day-head">';
      html += '<span class="day-date-label"><span class="day-num' + (retro ? ' retro-edited' : '') + '">' + cellDate.getDate() + '</span><span class="day-weekday">' + WD_ABBR[weekdayIdx] + '</span></span>';
      html += '<span class="day-head-right">';
      html += '<span class="day-total' + (total > 0 ? ' has-hours' : '') + (cancelled ? ' is-cancelled' : '') + '">' + (cancelled ? "Annulé" : (total > 0 ? fmtHM(total) : "—")) + '</span>';
      if(!locked && hasPlan){
        html += '<button class="day-cancel-btn' + (cancelled ? ' is-cancelled' : '') + '" data-day-cancel="' + dk + '" type="button" aria-label="' + (cancelled ? "Réactiver" : "Annuler") + ' la journée du ' + cellDate.getDate() + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M8 8l8 8"/></svg></button>';
      }
      if(!locked){
        html += '<button class="day-edit-btn" data-day-edit="' + dk + '" type="button" aria-label="Modifier l\'horaire du ' + cellDate.getDate() + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>';
      }
      html += '</span></div>';
      if(retro){
        html += '<span class="retro-badge" title="Modifié après la date passée">modifié</span>';
      }

      html += '<button class="chip' + (dayState.matin ? ' on-matin' : '') + '" data-day="' + dk + '" data-shift="matin" ' + (locked ? 'disabled' : '') + '>';
      html += '<span class="chip-label">Matin</span>';
      html += '<span class="chip-time' + (dayState.matinTime ? ' custom' : '') + '">' + matinRange.start + '–' + matinRange.end + '</span>';
      html += '</button>';

      html += '<button class="chip' + (dayState.soir ? ' on-soir' : '') + '" data-day="' + dk + '" data-shift="soir" ' + (locked ? 'disabled' : '') + '>';
      html += '<span class="chip-label">Soir</span>';
      html += '<span class="chip-time' + (dayState.soirTime ? ' custom' : '') + '">' + soirRange.start + '–' + soirRange.end + '</span>';
      html += '</button>';

      html += '</div>';
    }
    grid.innerHTML = html;
  }

  function renderDayEditor(md, monthLocked){
    var backdrop = document.getElementById("day-editor-backdrop");
    if(!editingDay || monthLocked){
      backdrop.hidden = true;
      return;
    }
    backdrop.hidden = false;
    var dk = editingDay;
    var parts = dk.split("-").map(Number);
    var cellDate = new Date(parts[0], parts[1] - 1, parts[2]);
    var weekdayIdx = (cellDate.getDay() + 6) % 7;
    document.getElementById("day-editor-title").textContent =
      capitalize(WEEKDAYS_FR[weekdayIdx]) + " " + parts[2] + " " + MONTHS_FR[parts[1] - 1];

    var dayState = md.days[dk] || { matin:false, soir:false };
    var isPast = isPastDate(dk);
    var body = document.getElementById("day-editor-body");
    var html = "";

    html += '<label class="cancel-toggle"><input type="checkbox" id="day-cancel-toggle" ' + (dayState.cancelled ? "checked" : "") + '> Journée annulée <span class="toggle-hint">(les heures repassent à 0, l’horaire saisi est conservé)</span></label>';

    ["matin","soir"].forEach(function(shift){
      var on = !!dayState[shift];
      var override = dayState[shift + "Time"];
      var eff = override || md[shift];
      var label = shift === "matin" ? "Matin" : "Soir";
      html += '<div class="day-editor-shift">';
      html += '<label class="shift-toggle"><input type="checkbox" data-shift-toggle="' + shift + '" ' + (on ? "checked" : "") + '> ' + label + '</label>';
      html += '<div class="range-inputs">';
      html += '<input type="time" data-shift-time="' + shift + '" data-field="start" value="' + eff.start + '" ' + (on ? "" : "disabled") + '>';
      html += '<span>→</span>';
      html += '<input type="time" data-shift-time="' + shift + '" data-field="end" value="' + eff.end + '" ' + (on ? "" : "disabled") + '>';
      html += '</div>';
      if(override){
        html += '<button class="link-quiet" data-shift-reset="' + shift + '" type="button">Réinitialiser à l’horaire du mois (' + md[shift].start + '–' + md[shift].end + ')</button>';
      }
      html += '</div>';
    });

    if(isPast){
      html += '<label class="silent-toggle"><input type="checkbox" id="day-silent-toggle" ' + (silentEdit ? "checked" : "") + '> Modification silencieuse <span class="toggle-hint">(ne pas marquer cette date comme modifiée après coup)</span></label>';
    }

    body.innerHTML = html;

    var cancelToggle = document.getElementById("day-cancel-toggle");
    if(cancelToggle){
      cancelToggle.addEventListener("change", function(e){
        if(!md.days[dk]) md.days[dk] = { matin:false, soir:false };
        md.days[dk].cancelled = e.target.checked;
        markDayEdited(md, dk, silentEdit);
        cleanupDay(md, dk);
        render();
        publishState();
      });
    }
    var silentToggle = document.getElementById("day-silent-toggle");
    if(silentToggle){
      silentToggle.addEventListener("change", function(e){
        silentEdit = e.target.checked;
      });
    }

    body.querySelectorAll("[data-shift-toggle]").forEach(function(cb){
      cb.addEventListener("change", function(e){
        var shift = e.target.getAttribute("data-shift-toggle");
        if(!md.days[dk]) md.days[dk] = { matin:false, soir:false };
        md.days[dk][shift] = e.target.checked;
        markDayEdited(md, dk, silentEdit);
        cleanupDay(md, dk);
        render();
        publishState();
      });
    });
    body.querySelectorAll("[data-shift-time]").forEach(function(inp){
      inp.addEventListener("change", function(e){
        var shift = e.target.getAttribute("data-shift-time");
        var field = e.target.getAttribute("data-field");
        if(!md.days[dk]) md.days[dk] = { matin:false, soir:false };
        var current = md.days[dk][shift + "Time"];
        var base = current ? { start: current.start, end: current.end } : { start: md[shift].start, end: md[shift].end };
        base[field] = e.target.value;
        md.days[dk][shift + "Time"] = base;
        markDayEdited(md, dk, silentEdit);
        render();
        publishState();
      });
    });
    body.querySelectorAll("[data-shift-reset]").forEach(function(btn){
      btn.addEventListener("click", function(e){
        var shift = e.target.getAttribute("data-shift-reset");
        if(md.days[dk]) delete md.days[dk][shift + "Time"];
        markDayEdited(md, dk, silentEdit);
        render();
        publishState();
      });
    });
  }

  function renderPrintSheet(md, key, locked, totalMin, totalPrice){
    var sheet = document.getElementById("print-sheet");
    var daysInMonth = new Date(view.year, view.month + 1, 0).getDate();
    var nannyLabel = state.nanny ? (" — " + state.nanny) : "";

    var rows = "";
    for(var d = 1; d <= daysInMonth; d++){
      var cellDate = new Date(view.year, view.month, d);
      var dk = dayKeyOf(view.year, view.month, d);
      var dayState = md.days[dk] || { matin:false, soir:false };
      var total = dayTotalMinutes(md, dk);
      var cancelled = !!dayState.cancelled;
      var weekdayIdx = (cellDate.getDay() + 6) % 7;
      var isWeekend = weekdayIdx >= 5;
      var matinRange = effectiveRange(md, dayState, "matin");
      var soirRange = effectiveRange(md, dayState, "soir");

      rows += '<tr class="' + (isWeekend ? 'weekend ' : '') + (cancelled ? 'cancelled ' : '') + (total > 0 ? 'worked' : '') + '">';
      rows += '<td>' + pad(d) + '/' + pad(view.month+1) + '</td>';
      rows += '<td>' + capitalize(WEEKDAYS_FR[weekdayIdx]) + '</td>';
      rows += '<td>' + (dayState.matin ? (matinRange.start + '–' + matinRange.end) : '—') + '</td>';
      rows += '<td>' + (dayState.soir ? (soirRange.start + '–' + soirRange.end) : '—') + '</td>';
      rows += '<td class="num">' + (cancelled ? "Annulé" : (total > 0 ? fmtHM(total) : '—')) + '</td>';
      rows += '</tr>';
    }

    var statusLine = locked
      ? ("Payé le " + fmtDateTimeFR(md.paid.date))
      : "Non payé";

    var html = "";
    html += "<h1>Planning de garde" + nannyLabel + "</h1>";
    html += '<p class="print-sub">' + capitalize(MONTHS_FR[view.month]) + " " + view.year +
      " · Matin " + md.matin.start + "–" + md.matin.end +
      " · Soir " + md.soir.start + "–" + md.soir.end +
      " · Taux horaire " + fmtEUR(md.rate) + "/h</p>";
    html += '<p class="print-legend"><i></i> Jour travaillé</p>';
    html += '<table><thead><tr><th>Date</th><th>Jour</th><th>Matin</th><th>Soir</th><th class="num">Heures</th></tr></thead><tbody>' + rows + '</tbody></table>';
    html += '<div class="print-foot">';
    html += '<span>Total heures : <span class="fig">' + (totalMin > 0 ? fmtHM(totalMin) : "0h") + '</span></span>';
    html += '<span>Total à payer : <span class="fig">' + fmtEUR(totalPrice) + '</span></span>';
    if(md.adjustment){
      html += '<span>Ajustement : <span class="fig">' + (md.adjustment > 0 ? "+" : "") + fmtEUR(md.adjustment) + '</span></span>';
    }
    html += '<span>Statut : <span class="fig">' + statusLine + '</span></span>';
    html += '</div>';
    if(md.observations && md.observations.trim()){
      html += '<div class="print-observations"><strong>Observations :</strong><br>' + escapeHtml(md.observations.trim()).replace(/\n/g, '<br>') + '</div>';
    }
    html += '<p class="print-gen">Édité le ' + fmtDateShort(new Date()) + '</p>';

    sheet.innerHTML = html;
  }

  // ---------- event wiring ----------
  function debounceSettingsSave(){
    if(settingsSaveTimer) clearTimeout(settingsSaveTimer);
    settingsSaveTimer = setTimeout(function(){ publishState(); }, 700);
  }

  function wireStaticEvents(){
    document.getElementById("prev-month").addEventListener("click", function(){
      view.month -= 1;
      if(view.month < 0){ view.month = 11; view.year -= 1; }
      confirmPay = false; confirmUnlock = false; editingDay = null;
      render();
    });
    document.getElementById("next-month").addEventListener("click", function(){
      view.month += 1;
      if(view.month > 11){ view.month = 0; view.year += 1; }
      confirmPay = false; confirmUnlock = false; editingDay = null;
      render();
    });
    document.getElementById("today-jump").addEventListener("click", function(){
      var now = new Date();
      view.year = now.getFullYear(); view.month = now.getMonth();
      editingDay = null;
      render();
    });

    document.getElementById("day-editor-close").addEventListener("click", function(){
      editingDay = null;
      silentEdit = false;
      render();
    });
    document.getElementById("day-editor-backdrop").addEventListener("click", function(e){
      if(e.target.id === "day-editor-backdrop"){ editingDay = null; silentEdit = false; render(); }
    });
    document.addEventListener("keydown", function(e){
      if(e.key === "Escape" && editingDay){ editingDay = null; silentEdit = false; render(); }
    });
    document.getElementById("settings-toggle").addEventListener("click", function(){
      uiSettingsOpen = !uiSettingsOpen;
      render();
    });

    document.getElementById("export-json").addEventListener("click", exportJson);
    document.getElementById("import-json").addEventListener("click", function(){
      document.getElementById("import-json-input").click();
    });
    document.getElementById("import-json-input").addEventListener("change", function(e){
      var file = e.target.files && e.target.files[0];
      e.target.value = ""; // allow re-picking the same file later
      importJsonFile(file);
    });

    document.getElementById("nanny-name").addEventListener("input", function(e){
      state.nanny = e.target.value;
      debounceSettingsSave();
    });

    document.getElementById("month-observations").addEventListener("input", function(e){
      var key = monthKey(view.year, view.month);
      var md = ensureMonth(key);
      md.observations = e.target.value;
      debounceSettingsSave();
    });

    ["matin-start","matin-end","soir-start","soir-end"].forEach(function(id){
      document.getElementById(id).addEventListener("change", function(e){
        var key = monthKey(view.year, view.month);
        var md = ensureMonth(key);
        var shift = id.indexOf("matin") === 0 ? "matin" : "soir";
        var field = id.endsWith("start") ? "start" : "end";
        md[shift][field] = e.target.value;
        state.lastSettings[shift][field] = e.target.value;
        render();
        publishState();
      });
    });
    document.getElementById("rate-input").addEventListener("change", function(e){
      var key = monthKey(view.year, view.month);
      var md = ensureMonth(key);
      var val = parseFloat(e.target.value);
      if(isNaN(val) || val < 0) val = 0;
      md.rate = val;
      state.lastSettings.rate = val;
      render();
      publishState();
    });
    document.getElementById("adjustment-input").addEventListener("change", function(e){
      var key = monthKey(view.year, view.month);
      var md = ensureMonth(key);
      var val = parseFloat(e.target.value);
      if(isNaN(val)) val = 0;
      md.adjustment = val;
      // Deliberately not carried into lastSettings: an adjustment is specific
      // to the month it was entered for, not a recurring template value.
      render();
      publishState();
    });

    document.getElementById("cal-grid").addEventListener("click", function(e){
      var editBtn = e.target.closest("[data-day-edit]");
      if(editBtn){
        editingDay = editBtn.getAttribute("data-day-edit");
        silentEdit = false;
        render();
        return;
      }
      var cancelBtn = e.target.closest("[data-day-cancel]");
      if(cancelBtn){
        var ckey = monthKey(view.year, view.month);
        var cmd = ensureMonth(ckey);
        if(cmd.paid) return;
        var cdk = cancelBtn.getAttribute("data-day-cancel");
        if(!cmd.days[cdk]) cmd.days[cdk] = { matin:false, soir:false };
        cmd.days[cdk].cancelled = !cmd.days[cdk].cancelled;
        markDayEdited(cmd, cdk, false);
        cleanupDay(cmd, cdk);
        render();
        publishState();
        return;
      }
      var btn = e.target.closest("[data-day]");
      if(!btn || btn.disabled) return;
      var key = monthKey(view.year, view.month);
      var md = ensureMonth(key);
      if(md.paid) return;
      var dk = btn.getAttribute("data-day");
      var shift = btn.getAttribute("data-shift");
      if(!md.days[dk]) md.days[dk] = { matin:false, soir:false };
      md.days[dk][shift] = !md.days[dk][shift];
      markDayEdited(md, dk, false);
      cleanupDay(md, dk);
      render();
      publishState();
    });
  }

  // ---------- init ----------
  function init(){
    wireStaticEvents();

    var localCopy = loadLocalState();
    state = normalizeState(localCopy || defaultState());
    render();

    var hasClaudeHost = (typeof window.claude !== "undefined" && window.claude && window.claude.use);
    if(!hasClaudeHost){
      // Standalone page (opened locally, e.g. from the Finder on a Mac, or
      // served by a plain web server): there is no claude.ai host to sync
      // with, so skip the network round-trip and rely on localStorage —
      // avoids a pointless failed fetch() and console noise.
      return;
    }

    fetchRemoteState().then(function(remote){
      if(remote){
        state = normalizeState(remote);
        render();
      }
      return window.claude.use("artifact");
    }).then(function(api){
      artifactAPI = api || null;
    }).catch(function(){
      artifactAPI = null;
    });
  }

  if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
