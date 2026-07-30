(() => {
  "use strict";

  const DB_NAME = "cardlens-db";
  const DB_VERSION = 1;
  const CARD_STORE = "cards";
  const SETTINGS_KEY = "cardlens-settings";
  const DEFAULT_SETTINGS = {
    apiBaseUrl: "",
    model: "taitra-mini",
    apiKey: "",
  };
  const CONTACT_FIELDS = [
    "name",
    "company",
    "title",
    "phone",
    "mobile",
    "email",
    "address",
    "notes",
  ];
  const STATUS_LABELS = {
    pending: "等待辨識",
    processing: "辨識中…",
    success: "辨識完成",
    error: "辨識失敗，可重試",
  };
  const AUTO_DETECTION = {
    intervalMs: 450,
    removalIntervalMs: 700,
    minConfidence: 0.32,
    minAspectRatio: 1.05,
    maxAspectRatio: 2.35,
    minFrameAreaRatio: 0.08,
    maxFrameAreaRatio: 0.92,
    minGuideCoverage: 0.25,
    guideToleranceRatio: 0.06,
    preferredClarity: 10,
    candidateFramesRequired: 2,
    removalFramesRequired: 3,
    guide: { left: 0.14, width: 0.72, aspectRatio: 1.586 },
  };

  const state = {
    db: null,
    dbPromise: null,
    mode: "auto",
    stream: null,
    facingMode: "environment",
    queue: [],
    cards: [],
    detectionTimer: null,
    candidateFrames: 0,
    lastDetection: null,
    detectionCandidates: [],
    scanPhase: "idle",
    removalMisses: 0,
    lastRemovalCheckAt: 0,
    autoBusy: false,
    manualCaptureBusy: false,
    visionReady: false,
    visionLoading: false,
    visionError: "",
    visionScanner: null,
    detectingFrame: false,
    objectUrls: new Set(),
    objectUrlCache: new WeakMap(),
    confirmAction: null,
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const els = {
    views: $$(".view"),
    navItems: $$(".nav-item"),
    routeLinks: $$("[data-route-link]"),
    modeButtons: $$("[data-mode]"),
    video: $("#cameraVideo"),
    cameraStage: $("#cameraStage"),
    overlay: $("#overlayCanvas"),
    captureCanvas: $("#captureCanvas"),
    cameraEmpty: $("#cameraEmpty"),
    cameraStatus: $("#cameraStatus"),
    cameraTip: $("#cameraTip"),
    scanLine: $("#scanLine"),
    startCamera: $("#startCameraButton"),
    switchCamera: $("#switchCameraButton"),
    capture: $("#captureButton"),
    imageInput: $("#imageInput"),
    modeHint: $("#modeHint"),
    queueList: $("#queueList"),
    queueTotal: $("#queueTotal"),
    queueProgressText: $("#queueProgressText"),
    selectAllQueue: $("#selectAllQueue"),
    recognizeSelected: $("#recognizeSelectedButton"),
    clearQueue: $("#clearQueueButton"),
    libraryCount: $("#libraryCount"),
    libraryGrid: $("#libraryGrid"),
    libraryEmpty: $("#libraryEmpty"),
    librarySearch: $("#librarySearch"),
    modeFilter: $("#modeFilter"),
    sortOrder: $("#sortOrder"),
    exportButton: $("#exportButton"),
    settingsForm: $("#settingsForm"),
    apiBaseUrl: $("#apiBaseUrl"),
    modelName: $("#modelName"),
    apiKey: $("#apiKey"),
    toggleApiKey: $("#toggleApiKey"),
    testConnection: $("#testConnectionButton"),
    testResult: $("#testResult"),
    connectionPill: $("#connectionPill"),
    connectionText: $("#connectionText"),
    deleteAllData: $("#deleteAllDataButton"),
    detailDialog: $("#detailDialog"),
    detailContent: $("#detailContent"),
    closeDetail: $("#closeDetailButton"),
    confirmDialog: $("#confirmDialog"),
    confirmTitle: $("#confirmTitle"),
    confirmMessage: $("#confirmMessage"),
    confirmCancel: $("#confirmCancel"),
    confirmAccept: $("#confirmAccept"),
    toastRegion: $("#toastRegion"),
  };

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    bindEvents();
    loadSettingsIntoForm();
    updateConnectionStatus();
    scheduleVisionInitialization();

    try {
      state.dbPromise = openDatabase();
      state.db = await state.dbPromise;
      await refreshCards();
    } catch (error) {
      toast(`無法開啟本機資料庫：${error.message}`, "error");
    }

    route(location.hash.replace("#", "") || "scanner");
    window.addEventListener("beforeunload", cleanup);
  }

  function bindEvents() {
    els.navItems.forEach((button) =>
      button.addEventListener("click", () => route(button.dataset.route)),
    );
    els.routeLinks.forEach((link) =>
      link.addEventListener("click", (event) => {
        event.preventDefault();
        route(link.dataset.routeLink);
      }),
    );
    els.modeButtons.forEach((button) =>
      button.addEventListener("click", () => setMode(button.dataset.mode)),
    );

    els.startCamera.addEventListener("click", toggleCamera);
    els.switchCamera.addEventListener("click", switchCamera);
    els.capture.addEventListener("click", () => captureFromVideo(false));
    els.imageInput.addEventListener("change", importImages);
    els.clearQueue.addEventListener("click", requestClearQueue);
    els.selectAllQueue.addEventListener("change", toggleSelectAll);
    els.recognizeSelected.addEventListener("click", recognizeSelected);
    els.queueList.addEventListener("click", handleQueueClick);
    els.queueList.addEventListener("change", updateQueueControls);

    els.librarySearch.addEventListener("input", renderLibrary);
    els.modeFilter.addEventListener("change", renderLibrary);
    els.sortOrder.addEventListener("change", renderLibrary);
    els.libraryGrid.addEventListener("click", handleLibraryClick);
    els.exportButton.addEventListener("click", exportExcel);

    els.settingsForm.addEventListener("submit", saveSettings);
    els.toggleApiKey.addEventListener("click", toggleApiKeyVisibility);
    els.testConnection.addEventListener("click", testConnection);
    els.deleteAllData.addEventListener("click", requestDeleteAllData);
    els.closeDetail.addEventListener("click", () => els.detailDialog.close());
    els.detailDialog.addEventListener("click", (event) => {
      if (event.target === els.detailDialog) els.detailDialog.close();
    });

    els.confirmCancel.addEventListener("click", () => {
      state.confirmAction = null;
      els.confirmDialog.close();
    });
    els.confirmAccept.addEventListener("click", async () => {
      const action = state.confirmAction;
      state.confirmAction = null;
      els.confirmDialog.close();
      if (action) await action();
    });

    window.addEventListener("hashchange", () =>
      route(location.hash.replace("#", "") || "scanner", false),
    );
  }

  function route(name, updateHash = true) {
    const validName = ["scanner", "library", "settings"].includes(name)
      ? name
      : "scanner";
    els.views.forEach((view) =>
      view.classList.toggle("active", view.dataset.view === validName),
    );
    els.navItems.forEach((button) =>
      button.classList.toggle("active", button.dataset.route === validName),
    );
    if (updateHash && location.hash !== `#${validName}`) {
      history.pushState(null, "", `#${validName}`);
    }
    if (validName === "library") renderLibrary();
  }

  function getSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
      if (!saved.apiKey) saved.apiKey = DEFAULT_SETTINGS.apiKey;
      return { ...DEFAULT_SETTINGS, ...saved };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function loadSettingsIntoForm() {
    const settings = getSettings();
    els.apiBaseUrl.value = settings.apiBaseUrl;
    els.modelName.value = settings.model;
    els.apiKey.value = settings.apiKey;
  }

  function saveSettings(event) {
    event.preventDefault();
    const settings = {
      apiBaseUrl: els.apiBaseUrl.value.trim().replace(/\/+$/, ""),
      model: els.modelName.value.trim(),
      apiKey: els.apiKey.value.trim(),
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    updateConnectionStatus();
    els.testResult.className = "test-result success";
    els.testResult.textContent = "設定已儲存在目前瀏覽器。";
    toast("API 設定已儲存");
  }

  function updateConnectionStatus() {
    const settings = getSettings();
    const ready = Boolean(settings.apiBaseUrl && settings.model && settings.apiKey);
    els.connectionPill.classList.toggle("ready", ready);
    els.connectionText.textContent = ready ? `已設定 ${settings.model}` : "尚未設定 API";
  }

  function toggleApiKeyVisibility() {
    const show = els.apiKey.type === "password";
    els.apiKey.type = show ? "text" : "password";
    els.toggleApiKey.textContent = show ? "隱藏" : "顯示";
    els.toggleApiKey.setAttribute("aria-label", show ? "隱藏 API Key" : "顯示 API Key");
  }

  async function testConnection() {
    const settings = {
      apiBaseUrl: els.apiBaseUrl.value.trim().replace(/\/+$/, ""),
      model: els.modelName.value.trim(),
      apiKey: els.apiKey.value.trim(),
    };
    if (!settings.apiBaseUrl || !settings.model || !settings.apiKey) {
      showTestResult("請先填寫所有欄位。", true);
      return;
    }

    els.testConnection.disabled = true;
    showTestResult("正在測試連線…");
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const response = await fetch(`${settings.apiBaseUrl}/models`, {
        headers: { Authorization: `Bearer ${settings.apiKey}` },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!response.ok) {
        const message = await readApiError(response);
        throw new Error(message);
      }
      showTestResult("連線成功，可以開始辨識。");
    } catch (error) {
      const message =
        error.name === "AbortError"
          ? "連線逾時，請確認 API URL。"
          : `連線失敗：${friendlyApiError(error)}`;
      showTestResult(message, true);
    } finally {
      els.testConnection.disabled = false;
    }
  }

  function showTestResult(message, isError = false) {
    els.testResult.className = `test-result ${isError ? "error" : "success"}`;
    els.testResult.textContent = message;
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(CARD_STORE)) {
          const store = db.createObjectStore(CARD_STORE, { keyPath: "id" });
          store.createIndex("capturedAt", "capturedAt");
          store.createIndex("mode", "mode");
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function dbRequest(method, value) {
    return new Promise((resolve, reject) => {
      if (!state.db) {
        reject(new Error("資料庫尚未就緒"));
        return;
      }
      const transaction = state.db.transaction(
        CARD_STORE,
        ["get", "getAll"].includes(method) ? "readonly" : "readwrite",
      );
      const store = transaction.objectStore(CARD_STORE);
      const request = method === "clear" ? store.clear() : store[method](value);
      let result;
      request.onsuccess = () => {
        result = request.result;
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error || request.error);
      transaction.onabort = () => reject(transaction.error || request.error || new Error("資料庫交易已中止"));
    });
  }

  async function ensureDatabase() {
    if (state.db) return state.db;
    if (!state.dbPromise) state.dbPromise = openDatabase();
    state.db = await state.dbPromise;
    return state.db;
  }

  async function refreshCards() {
    state.cards = await dbRequest("getAll");
    els.libraryCount.textContent = state.cards.length;
    renderLibrary();
  }

  async function toggleCamera() {
    if (state.stream) {
      stopCamera();
      return;
    }
    await startCamera();
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      toast("此瀏覽器或開啟方式不支援鏡頭，請改用「匯入照片」。", "error");
      return;
    }

    els.startCamera.disabled = true;
    setCameraStatus("正在開啟鏡頭…");
    try {
      state.stream = await getUserMediaWithTimeout({
        video: {
          facingMode: { ideal: state.facingMode },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      els.video.srcObject = state.stream;
      await els.video.play();
      els.cameraEmpty.classList.add("hidden");
      els.startCamera.textContent = "關閉鏡頭";
      els.capture.disabled = false;
      els.switchCamera.disabled = false;
      setCameraStatus(state.mode === "auto" ? "正在尋找名片" : "鏡頭已就緒", true);
      startDetection();
    } catch (error) {
      const message =
        error.name === "NotAllowedError"
          ? "鏡頭權限被拒絕，請允許權限或改用照片匯入。"
          : error.name === "TimeoutError"
            ? "等待鏡頭權限逾時，請確認瀏覽器權限後再試。"
          : "無法開啟鏡頭，請確認裝置未被其他程式占用。";
      toast(message, "error");
      setCameraStatus("鏡頭無法使用");
    } finally {
      els.startCamera.disabled = false;
    }
  }

  function getUserMediaWithTimeout(constraints, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        settled = true;
        const error = new Error("Camera permission timed out");
        error.name = "TimeoutError";
        reject(error);
      }, timeoutMs);

      navigator.mediaDevices.getUserMedia(constraints).then(
        (stream) => {
          if (settled) {
            stream.getTracks().forEach((track) => track.stop());
            return;
          }
          settled = true;
          window.clearTimeout(timer);
          resolve(stream);
        },
        (error) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  function stopCamera() {
    state.stream?.getTracks().forEach((track) => track.stop());
    state.stream = null;
    els.video.srcObject = null;
    els.cameraEmpty.classList.remove("hidden");
    els.startCamera.textContent = "開啟鏡頭";
    els.capture.disabled = true;
    els.switchCamera.disabled = true;
    setCameraStatus("等待鏡頭");
    stopDetection();
    clearOverlay();
  }

  async function switchCamera() {
    state.facingMode = state.facingMode === "environment" ? "user" : "environment";
    stopCamera();
    await startCamera();
  }

  function setMode(mode) {
    state.mode = mode;
    els.modeButtons.forEach((button) =>
      button.classList.toggle("active", button.dataset.mode === mode),
    );
    if (mode === "auto") {
      els.modeHint.innerHTML =
        "<span aria-hidden='true'>✦</span><p><strong>自動模式已啟用</strong> 偵測到完整名片後會快速選取較佳畫面並自動裁切；拍攝後請移開名片再換下一張。</p>";
      els.imageInput.multiple = false;
      if (state.stream) {
        setCameraStatus("正在尋找名片", true);
        startDetection();
      }
    } else {
      els.modeHint.innerHTML =
        "<span aria-hidden='true'>＋</span><p><strong>手動多張模式</strong> 一次拍攝多張名片時會依 bounding box 自動拆分；確認佇列後即可逐張辨識建檔。</p>";
      els.imageInput.multiple = true;
      els.scanLine.classList.remove("active");
      setCameraStatus(state.stream ? "鏡頭已就緒" : "等待鏡頭", Boolean(state.stream));
      stopDetection();
      clearOverlay();
    }
  }

  function setCameraStatus(text, ready = false) {
    els.cameraStatus.classList.toggle("ready", ready);
    $("span:last-child", els.cameraStatus).textContent = text;
  }

  function startDetection() {
    stopDetection();
    if (!state.stream || state.mode !== "auto") return;
    setScanPhase("searching");
    state.detectionTimer = window.setInterval(analyzeFrame, AUTO_DETECTION.intervalMs);
  }

  function stopDetection() {
    clearInterval(state.detectionTimer);
    state.detectionTimer = null;
    state.candidateFrames = 0;
    state.lastDetection = null;
    state.detectionCandidates = [];
    state.removalMisses = 0;
    state.lastRemovalCheckAt = 0;
    setScanPhase("idle");
  }

  function setScanPhase(phase) {
    state.scanPhase = phase;
    els.cameraStage.classList.toggle("is-locking", phase === "locking");
    els.cameraStage.classList.toggle("is-waiting-change", phase === "waitingRemoval");
    els.capture.disabled =
      !state.stream ||
      (state.mode === "auto" &&
        (state.autoBusy || ["capturing", "waitingRemoval"].includes(phase)));
    els.scanLine.classList.toggle(
      "active",
      Boolean(state.stream && state.mode === "auto" && phase === "searching"),
    );
  }

  function resetCandidateLock() {
    state.candidateFrames = 0;
    state.lastDetection = null;
    state.detectionCandidates = [];
    if (state.scanPhase === "locking") setScanPhase("searching");
  }

  async function analyzeFrame() {
    if (
      !state.stream ||
      state.mode !== "auto" ||
      state.scanPhase === "idle" ||
      state.scanPhase === "capturing" ||
      (state.autoBusy && state.scanPhase !== "waitingRemoval") ||
      state.detectingFrame ||
      els.video.readyState < 2
    ) {
      return;
    }

    if (state.visionLoading) {
      els.cameraTip.textContent = "正在載入名片偵測引擎…";
      return;
    }

    if (!state.visionReady) {
      resetCandidateLock();
      clearOverlay();
      if (!state.visionError) {
        els.cameraTip.textContent = "正在載入名片偵測引擎…";
        initializeVisionEngine();
        return;
      }
      setCameraStatus("自動偵測不可用", false);
      els.cameraTip.textContent = "請使用手動快門拍攝";
      return;
    }

    if (
      state.scanPhase === "waitingRemoval" &&
      Date.now() - state.lastRemovalCheckAt < AUTO_DETECTION.removalIntervalMs
    ) {
      return;
    }

    state.detectingFrame = true;
    let detection;
    try {
      detection = await detectCardWithScanic(els.video);
    } finally {
      state.detectingFrame = false;
    }

    if (state.scanPhase === "waitingRemoval") {
      state.lastRemovalCheckAt = Date.now();
      state.removalMisses = detection ? 0 : state.removalMisses + 1;
      els.cameraTip.textContent = detection
        ? "已拍攝，請移開名片"
        : `正在確認名片已移開 ${state.removalMisses}/${AUTO_DETECTION.removalFramesRequired}`;
      if (state.removalMisses >= AUTO_DETECTION.removalFramesRequired) {
        state.removalMisses = 0;
        state.lastDetection = null;
        state.candidateFrames = 0;
        state.detectionCandidates = [];
        clearOverlay();
        setScanPhase("searching");
        setCameraStatus(state.autoBusy ? "上一張辨識中" : "正在尋找名片", true);
        els.cameraTip.textContent = state.autoBusy
          ? "可放入下一張名片，等待上一張辨識完成"
          : "可放入下一張名片";
      }
      return;
    }

    if (!detection) {
      resetCandidateLock();
      clearOverlay();
      els.cameraTip.textContent = "正在尋找名片邊界";
      return;
    }

    const quality = evaluateDetection(detection);
    drawDetectionBox(detection.box, quality.clarity, detection.corners, quality.valid);
    if (!quality.valid) {
      resetCandidateLock();
      els.cameraTip.textContent = quality.hint;
      return;
    }

    const candidate = {
      detection,
      quality,
      frame: detection.sourceFrame,
      score: scoreDetectionCandidate(detection, quality),
    };
    state.detectionCandidates = [...state.detectionCandidates, candidate].slice(
      -AUTO_DETECTION.candidateFramesRequired,
    );
    state.candidateFrames = state.detectionCandidates.length;
    state.lastDetection = detection;
    setScanPhase("locking");

    if (state.candidateFrames >= AUTO_DETECTION.candidateFramesRequired) {
      const bestCandidate = state.detectionCandidates.reduce((best, entry) =>
        entry.score > best.score ? entry : best,
      );
      const bestDetection = bestCandidate.detection;
      const bestQuality = bestCandidate.quality;
      const metrics = {
        engine: "scanic-classical",
        confidence: bestDetection.score,
        clarity: bestQuality.clarity,
        candidateFrames: state.candidateFrames,
        comparedCandidates: state.detectionCandidates.length,
        candidateScore: bestCandidate.score,
        aspectRatio: bestQuality.aspectRatio,
      };
      state.candidateFrames = 0;
      state.lastDetection = null;
      state.detectionCandidates = [];
      await captureFromVideo(
        true,
        bestDetection.box,
        bestDetection.corners,
        metrics,
        bestCandidate.frame,
      );
    } else {
      els.cameraTip.textContent =
        `已偵測到名片 ${state.candidateFrames}/${AUTO_DETECTION.candidateFramesRequired}`;
    }
  }

  function scheduleVisionInitialization() {
    const start = () => initializeVisionEngine();
    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(start, { timeout: 1500 });
    } else {
      window.setTimeout(start, 250);
    }
  }

  async function initializeVisionEngine() {
    if (state.visionReady || state.visionLoading) return;
    state.visionLoading = true;
    try {
      await loadScript("vendor/scanic.js");
      if (!globalThis.scanic?.Scanner) throw new Error("Scanic API 無法使用");
      state.visionScanner = new globalThis.scanic.Scanner({
        detector: "classical",
        mode: "detect",
        maxProcessingDimension: 560,
        lowThreshold: 30,
        highThreshold: 105,
        applyDilation: true,
        dilationKernelSize: 5,
        dilationIterations: 1,
        minArea: 900,
        epsilon: 0.025,
        minDetectionConfidence: AUTO_DETECTION.minConfidence,
        maxCandidateContours: 18,
        enableDetectionCascade: true,
        minDocumentCoverageRatio: AUTO_DETECTION.minFrameAreaRatio,
        minDocumentSideRatio: 0.12,
        minDocumentFillRatio: 0.32,
        minRightAngleScore: 0.2,
        minOppositeSideConsistency: 0.1,
        maxDocumentAspectRatio: AUTO_DETECTION.maxAspectRatio,
      });
      await state.visionScanner.initialize();
      state.visionReady = true;
      state.visionError = "";
      if (
        state.stream &&
        state.mode === "auto" &&
        ["searching", "locking"].includes(state.scanPhase)
      ) {
        setCameraStatus("名片邊界偵測已就緒", true);
        els.cameraTip.textContent = "將名片移入畫面";
      }
    } catch (error) {
      state.visionError = error.message;
      console.warn("Scanic unavailable; automatic capture is disabled.", error);
      if (state.stream && state.mode === "auto") {
        setCameraStatus("自動偵測不可用");
        els.cameraTip.textContent = "請使用手動快門拍攝";
      }
    } finally {
      state.visionLoading = false;
    }
  }

  async function ensureVisionEngineReady(timeoutMs = 4000) {
    if (state.visionReady) return true;
    if (!state.visionLoading) await initializeVisionEngine();
    const deadline = Date.now() + timeoutMs;
    while (state.visionLoading && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    return state.visionReady;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) {
        if (globalThis.scanic?.Scanner) resolve();
        else existing.addEventListener("load", resolve, { once: true });
        return;
      }
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error("無法載入本機名片偵測引擎"));
      document.head.append(script);
    });
  }

  async function detectCardWithScanic(source) {
    const sourceFrame = document.createElement("canvas");
    const workCanvas = document.createElement("canvas");
    const sourceWidth = source.videoWidth || source.width;
    const sourceHeight = source.videoHeight || source.height;
    if (!sourceWidth || !sourceHeight) return null;
    sourceFrame.width = sourceWidth;
    sourceFrame.height = sourceHeight;
    sourceFrame.getContext("2d").drawImage(source, 0, 0, sourceWidth, sourceHeight);
    const scale = Math.min(1, 560 / sourceWidth);
    workCanvas.width = Math.max(1, Math.round(sourceWidth * scale));
    workCanvas.height = Math.max(1, Math.round(sourceHeight * scale));
    workCanvas
      .getContext("2d")
      .drawImage(sourceFrame, 0, 0, workCanvas.width, workCanvas.height);

    try {
      const result = await state.visionScanner.scan(workCanvas, {
        mode: "detect",
        detector: "classical",
      });
      if (!result?.success || !result.corners) return null;
      const corners = [
        result.corners.topLeft,
        result.corners.topRight,
        result.corners.bottomRight,
        result.corners.bottomLeft,
      ].map((point) => ({ x: point.x / scale, y: point.y / scale }));
      const detection = detectionFromCorners(
        corners,
        sourceWidth,
        sourceHeight,
        Number(result.confidence) || 0,
      );
      const topWidth = pointDistance(corners[0], corners[1]);
      const bottomWidth = pointDistance(corners[3], corners[2]);
      const leftHeight = pointDistance(corners[0], corners[3]);
      const rightHeight = pointDistance(corners[1], corners[2]);
      const averageWidth = (topWidth + bottomWidth) / 2;
      const averageHeight = (leftHeight + rightHeight) / 2;
      const ratio =
        Math.max(averageWidth, averageHeight) /
        Math.max(1, Math.min(averageWidth, averageHeight));
      const areaRatio =
        (detection.box.width * detection.box.height) / (sourceWidth * sourceHeight);
      if (
        ratio < AUTO_DETECTION.minAspectRatio ||
        ratio > AUTO_DETECTION.maxAspectRatio ||
        areaRatio < AUTO_DETECTION.minFrameAreaRatio ||
        areaRatio > AUTO_DETECTION.maxFrameAreaRatio
      ) {
        return null;
      }
      detection.sourceFrame = sourceFrame;
      return detection;
    } catch (error) {
      console.warn("Scanic card detection failed.", error);
      return null;
    }
  }

  async function detectMultipleCardsWithScanic(source) {
    const sourceWidth = source.width;
    const sourceHeight = source.height;
    if (!sourceWidth || !sourceHeight || !state.visionReady) return [];

    const overlap = 0.08;
    const halfWidth = 0.5 + overlap;
    const halfHeight = 0.5 + overlap;
    const regions = [
      { x: 0, y: 0, width: 1, height: 1 },
      { x: 0, y: 0, width: halfWidth, height: 1 },
      { x: 1 - halfWidth, y: 0, width: halfWidth, height: 1 },
      { x: 0, y: 0, width: 1, height: halfHeight },
      { x: 0, y: 1 - halfHeight, width: 1, height: halfHeight },
      { x: 0, y: 0, width: halfWidth, height: halfHeight },
      { x: 1 - halfWidth, y: 0, width: halfWidth, height: halfHeight },
      { x: 0, y: 1 - halfHeight, width: halfWidth, height: halfHeight },
      {
        x: 1 - halfWidth,
        y: 1 - halfHeight,
        width: halfWidth,
        height: halfHeight,
      },
    ];
    const detections = [];

    for (const region of regions) {
      const x = Math.round(region.x * sourceWidth);
      const y = Math.round(region.y * sourceHeight);
      const width = Math.min(sourceWidth - x, Math.round(region.width * sourceWidth));
      const height = Math.min(sourceHeight - y, Math.round(region.height * sourceHeight));
      const regionCanvas = document.createElement("canvas");
      regionCanvas.width = width;
      regionCanvas.height = height;
      regionCanvas
        .getContext("2d")
        .drawImage(source, x, y, width, height, 0, 0, width, height);
      const localDetection = await detectCardWithScanic(regionCanvas);
      if (!localDetection) continue;

      const corners = localDetection.corners.map((point) => ({
        x: point.x + x,
        y: point.y + y,
      }));
      const detection = detectionFromCorners(
        corners,
        sourceWidth,
        sourceHeight,
        localDetection.score,
      );
      const areaRatio =
        (detection.box.width * detection.box.height) / (sourceWidth * sourceHeight);
      if (areaRatio < 0.015 || areaRatio > AUTO_DETECTION.maxFrameAreaRatio) continue;

      const duplicateIndex = detections.findIndex((entry) =>
        detectionBoxesOverlap(entry.box, detection.box),
      );
      if (duplicateIndex < 0) {
        detections.push(detection);
      } else if (detection.score > detections[duplicateIndex].score) {
        detections[duplicateIndex] = detection;
      }
    }

    return detections
      .sort((a, b) => {
        const rowTolerance = Math.min(a.box.height, b.box.height) * 0.35;
        return Math.abs(a.box.y - b.box.y) <= rowTolerance
          ? a.box.x - b.box.x
          : a.box.y - b.box.y;
      })
      .slice(0, 12);
  }

  function detectionBoxesOverlap(a, b) {
    const left = Math.max(a.x, b.x);
    const top = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.width, b.x + b.width);
    const bottom = Math.min(a.y + a.height, b.y + b.height);
    const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
    const smallerArea = Math.min(a.width * a.height, b.width * b.height);
    return intersection / Math.max(1, smallerArea) >= 0.6;
  }

  function detectCardWithCanvas(source) {
    const sourceWidth = source.videoWidth || source.width;
    const sourceHeight = source.videoHeight || source.height;
    if (!sourceWidth || !sourceHeight) return null;
    const canvas = document.createElement("canvas");
    canvas.width = 240;
    canvas.height = Math.max(120, Math.round((sourceHeight / sourceWidth) * canvas.width));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const edges = [];
    let mean = 0;
    let count = 0;
    for (let y = 2; y < canvas.height - 2; y += 2) {
      for (let x = 2; x < canvas.width - 2; x += 2) {
        const i = (y * canvas.width + x) * 4;
        const horizontal = Math.abs(luma(pixels, i - 8) - luma(pixels, i + 8));
        const vertical = Math.abs(
          luma(pixels, i - canvas.width * 8) - luma(pixels, i + canvas.width * 8),
        );
        const magnitude = horizontal + vertical;
        mean += magnitude;
        count += 1;
        edges.push({ x, y, magnitude });
      }
    }
    mean /= Math.max(1, count);
    const strong = edges.filter((edge) => edge.magnitude > Math.max(34, mean * 1.7));
    if (strong.length < 70) return null;
    const xs = strong.map((edge) => edge.x).sort((a, b) => a - b);
    const ys = strong.map((edge) => edge.y).sort((a, b) => a - b);
    const left = percentile(xs, 0.04);
    const right = percentile(xs, 0.96);
    const top = percentile(ys, 0.04);
    const bottom = percentile(ys, 0.96);
    const width = right - left;
    const height = bottom - top;
    const ratio = Math.max(width, height) / Math.max(1, Math.min(width, height));
    const areaRatio = (width * height) / (canvas.width * canvas.height);
    if (ratio < 1.15 || ratio > 2.25 || areaRatio < 0.08 || areaRatio > 0.92) return null;
    const scaleX = sourceWidth / canvas.width;
    const scaleY = sourceHeight / canvas.height;
    const corners = [
      { x: left * scaleX, y: top * scaleY },
      { x: right * scaleX, y: top * scaleY },
      { x: right * scaleX, y: bottom * scaleY },
      { x: left * scaleX, y: bottom * scaleY },
    ];
    return detectionFromCorners(corners, sourceWidth, sourceHeight, areaRatio);
  }

  function detectionFromCorners(corners, sourceWidth, sourceHeight, score) {
    const xs = corners.map((point) => point.x);
    const ys = corners.map((point) => point.y);
    const box = normalizeBox(
      {
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
      },
      sourceWidth,
      sourceHeight,
    );
    return { box, corners, score };
  }

  function pointDistance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function luma(pixels, index) {
    return pixels[index] * 0.299 + pixels[index + 1] * 0.587 + pixels[index + 2] * 0.114;
  }

  function percentile(values, ratio) {
    return values[Math.min(values.length - 1, Math.max(0, Math.floor(values.length * ratio)))];
  }

  function estimateClarity(box) {
    const canvas = els.captureCanvas;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const width = 160;
    const height = Math.max(80, Math.round((box.height / box.width) * width));
    canvas.width = width;
    canvas.height = height;
    context.drawImage(
      els.video,
      box.x,
      box.y,
      box.width,
      box.height,
      0,
      0,
      width,
      height,
    );
    const pixels = context.getImageData(0, 0, width, height).data;
    let total = 0;
    let samples = 0;
    for (let y = 1; y < height - 1; y += 2) {
      for (let x = 1; x < width - 1; x += 2) {
        const i = (y * width + x) * 4;
        const left = pixels[i - 4] + pixels[i - 3] + pixels[i - 2];
        const right = pixels[i + 4] + pixels[i + 5] + pixels[i + 6];
        const up = pixels[i - width * 4] + pixels[i - width * 4 + 1] + pixels[i - width * 4 + 2];
        const down = pixels[i + width * 4] + pixels[i + width * 4 + 1] + pixels[i + width * 4 + 2];
        total += Math.abs(right - left) + Math.abs(down - up);
        samples += 1;
      }
    }
    return samples ? total / samples / 8 : 0;
  }

  function evaluateDetection(detection) {
    const corners = detection.corners;
    const clarity = estimateClarity(detection.box);
    const widths = [
      pointDistance(corners[0], corners[1]),
      pointDistance(corners[3], corners[2]),
    ];
    const heights = [
      pointDistance(corners[0], corners[3]),
      pointDistance(corners[1], corners[2]),
    ];
    const averageWidth = (widths[0] + widths[1]) / 2;
    const averageHeight = (heights[0] + heights[1]) / 2;
    const aspectRatio =
      Math.max(averageWidth, averageHeight) /
      Math.max(1, Math.min(averageWidth, averageHeight));
    const guide = getGuideBoundsInVideo();
    const toleranceX = els.video.videoWidth * AUTO_DETECTION.guideToleranceRatio;
    const toleranceY = els.video.videoHeight * AUTO_DETECTION.guideToleranceRatio;
    const insideGuide = corners.every(
      (point) =>
        point.x >= guide.left - toleranceX &&
        point.x <= guide.right + toleranceX &&
        point.y >= guide.top - toleranceY &&
        point.y <= guide.bottom + toleranceY,
    );
    const guideArea = Math.max(1, (guide.right - guide.left) * (guide.bottom - guide.top));
    const guideCoverage = polygonArea(corners) / guideArea;

    if (detection.score < AUTO_DETECTION.minConfidence) {
      return { valid: false, clarity, aspectRatio, hint: "尚未確認為完整名片" };
    }
    if (
      aspectRatio < AUTO_DETECTION.minAspectRatio ||
      aspectRatio > AUTO_DETECTION.maxAspectRatio
    ) {
      return { valid: false, clarity, aspectRatio, hint: "請將完整名片對齊框線" };
    }
    if (!insideGuide) {
      return { valid: false, clarity, aspectRatio, hint: "請將名片完整移入框線內" };
    }
    if (guideCoverage < AUTO_DETECTION.minGuideCoverage) {
      return { valid: false, clarity, aspectRatio, hint: "請將名片靠近鏡頭一些" };
    }
    return { valid: true, clarity, aspectRatio, guideCoverage, hint: "" };
  }

  function polygonArea(points) {
    let area = 0;
    points.forEach((point, index) => {
      const next = points[(index + 1) % points.length];
      area += point.x * next.y - next.x * point.y;
    });
    return Math.abs(area) / 2;
  }

  function scoreDetectionCandidate(detection, quality) {
    const expectedAspectRatio = AUTO_DETECTION.guide.aspectRatio;
    const aspectScore = Math.max(
      0,
      1 - Math.abs(quality.aspectRatio - expectedAspectRatio) / expectedAspectRatio,
    );
    const confidenceScore = Math.max(0, Math.min(1, detection.score));
    const clarityScore = Math.max(
      0,
      Math.min(1, quality.clarity / (AUTO_DETECTION.preferredClarity * 2)),
    );
    return confidenceScore * 0.6 + aspectScore * 0.25 + clarityScore * 0.15;
  }

  function getVideoCoverTransform() {
    const rect = els.video.getBoundingClientRect();
    const scale = Math.max(
      rect.width / Math.max(1, els.video.videoWidth),
      rect.height / Math.max(1, els.video.videoHeight),
    );
    const renderedWidth = els.video.videoWidth * scale;
    const renderedHeight = els.video.videoHeight * scale;
    return {
      rect,
      scale,
      offsetX: (rect.width - renderedWidth) / 2,
      offsetY: (rect.height - renderedHeight) / 2,
    };
  }

  function getGuideBoundsInVideo() {
    const { rect, scale, offsetX, offsetY } = getVideoCoverTransform();
    const guideLeft = rect.width * AUTO_DETECTION.guide.left;
    const guideWidth = rect.width * AUTO_DETECTION.guide.width;
    const guideHeight = guideWidth / AUTO_DETECTION.guide.aspectRatio;
    const guideTop = (rect.height - guideHeight) / 2;
    return {
      left: (guideLeft - offsetX) / scale,
      right: (guideLeft + guideWidth - offsetX) / scale,
      top: (guideTop - offsetY) / scale,
      bottom: (guideTop + guideHeight - offsetY) / scale,
    };
  }

  function drawDetectionBox(box, clarity, corners = null, valid = true) {
    const canvas = els.overlay;
    const { rect, scale, offsetX, offsetY } = getVideoCoverTransform();
    canvas.width = Math.round(rect.width * devicePixelRatio);
    canvas.height = Math.round(rect.height * devicePixelRatio);
    const context = canvas.getContext("2d");
    const toCanvas = (point) => ({
      x: (point.x * scale + offsetX) * devicePixelRatio,
      y: (point.y * scale + offsetY) * devicePixelRatio,
    });
    context.strokeStyle = valid ? "#5fe29f" : "#e5aa48";
    context.lineWidth = 3 * devicePixelRatio;
    context.setLineDash([10 * devicePixelRatio, 7 * devicePixelRatio]);
    if (corners?.length === 4) {
      const canvasCorners = corners.map(toCanvas);
      context.beginPath();
      context.moveTo(canvasCorners[0].x, canvasCorners[0].y);
      canvasCorners.slice(1).forEach((point) => context.lineTo(point.x, point.y));
      context.closePath();
      context.stroke();
    } else {
      const origin = toCanvas({ x: box.x, y: box.y });
      context.strokeRect(
        origin.x,
        origin.y,
        box.width * scale * devicePixelRatio,
        box.height * scale * devicePixelRatio,
      );
    }
  }

  function clearOverlay() {
    const context = els.overlay.getContext("2d");
    context.clearRect(0, 0, els.overlay.width, els.overlay.height);
  }

  async function captureFromVideo(
    isAuto = false,
    providedBox = null,
    corners = null,
    detectionMetrics = null,
    providedFrame = null,
  ) {
    if (
      !state.stream ||
      els.video.readyState < 2 ||
      (!isAuto && state.manualCaptureBusy)
    ) {
      return;
    }
    if (isAuto) {
      state.autoBusy = true;
      setScanPhase("capturing");
      setCameraStatus("正在儲存名片", true);
      els.cameraTip.textContent = "正在裁切名片範圍";
    } else {
      state.manualCaptureBusy = true;
      els.capture.disabled = true;
      setCameraStatus("正在拆分名片", true);
      els.cameraTip.textContent = "正在尋找照片中的名片範圍";
    }

    try {
      const fullCanvas = providedFrame || document.createElement("canvas");
      if (!providedFrame) {
        fullCanvas.width = els.video.videoWidth;
        fullCanvas.height = els.video.videoHeight;
        fullCanvas.getContext("2d").drawImage(els.video, 0, 0);
      }
      if (!isAuto && state.mode === "manual") {
        const visionReady = await ensureVisionEngineReady();
        const detections = visionReady
          ? await detectMultipleCardsWithScanic(fullCanvas)
          : [];
        const captureGroupId = createId();
        const cards = detections.length
          ? detections
          : [
              {
                box: normalizeBox(
                  {
                    x: fullCanvas.width * 0.08,
                    y: fullCanvas.height * 0.1,
                    width: fullCanvas.width * 0.84,
                    height: fullCanvas.height * 0.8,
                  },
                  fullCanvas.width,
                  fullCanvas.height,
                ),
                corners: null,
              },
            ];
        for (const [index, detection] of cards.entries()) {
          const captured = await makeCapturedImages(
            fullCanvas,
            detection.box,
            detection.corners,
          );
          captured.captureGroupId = captureGroupId;
          captured.cardIndex = index + 1;
          captured.cardCount = cards.length;
          await addToQueue(
            captured,
            "manual",
            cards.length > 1 ? `同次拍攝 ${index + 1}/${cards.length}` : "",
          );
        }
        toast(
          detections.length
            ? `已從照片擷取 ${cards.length} 張名片`
            : "未找到明確邊界，已保留中央範圍供手動辨識",
        );
        return;
      }
      const box =
        providedBox ||
        normalizeBox({
          x: fullCanvas.width * 0.12,
          y: fullCanvas.height * 0.16,
          width: fullCanvas.width * 0.76,
          height: fullCanvas.height * 0.68,
        }, fullCanvas.width, fullCanvas.height);
      const captured = await makeCapturedImages(fullCanvas, box, corners);
      if (detectionMetrics) captured.detectionMetrics = detectionMetrics;
      const queueResult = await addToQueue(captured, isAuto ? "auto" : state.mode);

      if (!isAuto) {
        toast("照片已加入處理佇列");
        return;
      }
      if (!queueResult.persisted) throw new Error("名片未能寫入 IndexedDB");

      state.removalMisses = 0;
      state.lastRemovalCheckAt = 0;
      clearOverlay();
      setScanPhase("waitingRemoval");
      els.cameraTip.textContent = "已拍攝，請移開名片";
      setCameraStatus("正在辨識名片", true);
      await recognizeQueueItem(captured.queueId);
    } catch (error) {
      if (!isAuto) {
        toast(`拍攝與拆分失敗：${error.message}`, "error");
        return;
      }
      toast(`自動拍攝失敗：${error.message}`, "error");
      resetCandidateLock();
      setScanPhase("searching");
      setCameraStatus("正在尋找名片", true);
      els.cameraTip.textContent = "請重新將名片對齊框線";
    } finally {
      if (isAuto) {
        state.autoBusy = false;
        setScanPhase(state.scanPhase);
        if (state.scanPhase === "waitingRemoval") {
          setCameraStatus("已拍攝，等待換卡", true);
          els.cameraTip.textContent = "請移開已拍攝的名片";
        } else if (state.scanPhase === "searching") {
          setCameraStatus("正在尋找名片", true);
        }
      } else {
        state.manualCaptureBusy = false;
        els.capture.disabled = !state.stream;
        setCameraStatus(state.stream ? "鏡頭已就緒" : "等待鏡頭", Boolean(state.stream));
        els.cameraTip.textContent = "可繼續拍攝，或勾選名片開始辨識";
      }
    }
  }

  async function importImages(event) {
    const files = [...event.target.files];
    event.target.value = "";
    if (!files.length) return;
    const selectedFiles = state.mode === "auto" ? files.slice(0, 1) : files;

    for (const file of selectedFiles) {
      try {
        const image = await loadImage(file);
        const canvas = document.createElement("canvas");
        const maxWidth = 2200;
        const scale = Math.min(1, maxWidth / image.naturalWidth);
        canvas.width = Math.round(image.naturalWidth * scale);
        canvas.height = Math.round(image.naturalHeight * scale);
        canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
        if (!state.visionReady && !state.visionLoading) await initializeVisionEngine();
        const detection = state.visionReady ? await detectCardWithScanic(canvas) : null;
        const box = detection?.box || detectImportedCardBox(canvas);
        const captured = await makeCapturedImages(canvas, box, detection?.corners);
        await addToQueue(captured, state.mode, file.name);
        if (state.mode === "auto") await recognizeQueueItem(captured.queueId);
      } catch (error) {
        toast(`無法讀取 ${file.name}：${error.message}`, "error");
      }
    }
    toast(`已匯入 ${selectedFiles.length} 張照片`);
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("圖片格式不支援"));
      };
      image.src = url;
    });
  }

  function detectImportedCardBox(canvas) {
    const imageRatio = canvas.width / canvas.height;
    let width;
    let height;
    if (imageRatio >= 1.25 && imageRatio <= 2.1) {
      width = canvas.width * 0.94;
      height = canvas.height * 0.9;
    } else {
      width = canvas.width * 0.84;
      height = Math.min(width / 1.586, canvas.height * 0.7);
    }
    return normalizeBox(
      {
        x: (canvas.width - width) / 2,
        y: (canvas.height - height) / 2,
        width,
        height,
      },
      canvas.width,
      canvas.height,
    );
  }

  function normalizeBox(box, width, height) {
    const x = Math.max(0, Math.round(box.x));
    const y = Math.max(0, Math.round(box.y));
    return {
      x,
      y,
      width: Math.min(Math.round(box.width), width - x),
      height: Math.min(Math.round(box.height), height - y),
    };
  }

  async function makeCapturedImages(sourceCanvas, box, corners = null) {
    const originalImage = await canvasToBlob(sourceCanvas);
    let cropCanvas = null;
    let cropMethod = "bounding-box";
    if (corners?.length === 4 && state.visionScanner) {
      try {
        const extraction = await state.visionScanner.extract(
          sourceCanvas,
          {
            topLeft: corners[0],
            topRight: corners[1],
            bottomRight: corners[2],
            bottomLeft: corners[3],
          },
          { output: "canvas" },
        );
        if (extraction?.success && extraction.output?.width && extraction.output?.height) {
          cropCanvas = extraction.output;
          cropMethod = "perspective";
        }
      } catch (error) {
        console.warn("Perspective crop failed; using bounding box.", error);
      }
    }
    if (!cropCanvas) {
      cropCanvas = document.createElement("canvas");
      cropCanvas.width = box.width;
      cropCanvas.height = box.height;
      cropCanvas
        .getContext("2d")
        .drawImage(
          sourceCanvas,
          box.x,
          box.y,
          box.width,
          box.height,
          0,
          0,
          box.width,
          box.height,
        );
    }
    const croppedImage = await canvasToBlob(cropCanvas);

    const annotatedCanvas = document.createElement("canvas");
    annotatedCanvas.width = sourceCanvas.width;
    annotatedCanvas.height = sourceCanvas.height;
    const context = annotatedCanvas.getContext("2d");
    context.drawImage(sourceCanvas, 0, 0);
    context.strokeStyle = "#23b979";
    context.lineWidth = Math.max(5, sourceCanvas.width * 0.006);
    context.setLineDash([24, 14]);
    if (corners?.length === 4) {
      context.beginPath();
      context.moveTo(corners[0].x, corners[0].y);
      corners.slice(1).forEach((point) => context.lineTo(point.x, point.y));
      context.closePath();
      context.stroke();
    } else {
      context.strokeRect(box.x, box.y, box.width, box.height);
    }
    const annotatedImage = await canvasToBlob(annotatedCanvas);

    return {
      queueId: createId(),
      originalImage,
      croppedImage,
      annotatedImage,
      boundingBox: box,
      corners: corners || null,
      cropMethod,
      imageWidth: sourceCanvas.width,
      imageHeight: sourceCanvas.height,
    };
  }

  function canvasToBlob(canvas, quality = 0.88) {
    return new Promise((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("圖片處理失敗"))),
        "image/jpeg",
        quality,
      ),
    );
  }

  async function addToQueue(captured, mode, filename = "") {
    const item = {
      ...captured,
      mode,
      filename,
      capturedAt: new Date().toISOString(),
      status: "pending",
      selected: true,
      error: "",
    };
    state.queue.unshift(item);
    renderQueue();
    let persisted = false;
    try {
      await persistQueueItem(item);
      await refreshCards();
      persisted = true;
    } catch (error) {
      item.status = "error";
      item.error = `無法寫入 IndexedDB：${error.message}`;
      toast(item.error, "error");
      renderQueue();
    }
    return { item, persisted };
  }

  function renderQueue() {
    els.queueTotal.textContent = state.queue.length;
    const processing = state.queue.filter((item) => item.status === "processing").length;
    const successes = state.queue.filter((item) => item.status === "success").length;
    els.queueProgressText.textContent = processing
      ? `${processing} 張辨識中`
      : successes
        ? `${successes} 張已完成`
        : state.queue.length
          ? "等待開始辨識"
          : "尚無待處理項目";

    if (!state.queue.length) {
      els.queueList.innerHTML = `
        <div class="empty-state compact">
          <span aria-hidden="true">▧</span>
          <strong>等待第一張名片</strong>
          <p>拍攝或匯入後會顯示在這裡。</p>
        </div>`;
      updateQueueControls();
      return;
    }

    els.queueList.innerHTML = state.queue
      .map((item) => {
        const url = makeObjectUrl(item.croppedImage);
        const statusClass =
          item.status === "success"
            ? "success"
            : item.status === "error"
              ? "error"
              : item.status === "processing"
                ? "processing"
                : "";
        const displayName =
          item.contact?.name || item.filename || `名片 ${formatTime(item.capturedAt)}`;
        return `
          <div class="queue-item" data-id="${item.queueId}">
            <input class="queue-check" type="checkbox" aria-label="選取 ${escapeHtml(displayName)}"
              ${item.selected ? "checked" : ""} ${item.status === "processing" ? "disabled" : ""} />
            <img class="queue-thumb" src="${url}" alt="名片預覽" />
            <div class="queue-info">
              <strong>${escapeHtml(displayName)}</strong>
              <small class="${statusClass}">${escapeHtml(STATUS_LABELS[item.status] || item.status)}</small>
            </div>
            <button class="queue-remove" data-action="remove" type="button" aria-label="移除" ${item.status === "processing" ? "disabled" : ""}>×</button>
          </div>`;
      })
      .join("");
    updateQueueControls();
  }

  function handleQueueClick(event) {
    const itemElement = event.target.closest(".queue-item");
    if (!itemElement) return;
    const item = state.queue.find((entry) => entry.queueId === itemElement.dataset.id);
    if (!item) return;
    if (event.target.matches("[data-action='remove']")) {
      state.queue = state.queue.filter((entry) => entry.queueId !== item.queueId);
      renderQueue();
    }
  }

  function updateQueueControls() {
    $$(".queue-item").forEach((element) => {
      const item = state.queue.find((entry) => entry.queueId === element.dataset.id);
      const checkbox = $(".queue-check", element);
      if (item && checkbox) item.selected = checkbox.checked;
    });
    const selectable = state.queue.filter((item) => item.status !== "processing");
    const selected = selectable.filter((item) => item.selected);
    els.selectAllQueue.checked = Boolean(selectable.length && selected.length === selectable.length);
    els.selectAllQueue.indeterminate = Boolean(selected.length && selected.length < selectable.length);
    els.selectAllQueue.disabled = !selectable.length;
    els.recognizeSelected.disabled = !selected.length || state.queue.some((item) => item.status === "processing");
    els.recognizeSelected.textContent = selected.some((item) => item.status === "error")
      ? `重試所選名片（${selected.length}）`
      : `辨識所選名片（${selected.length}）`;
  }

  function toggleSelectAll() {
    state.queue.forEach((item) => {
      if (item.status !== "processing") item.selected = els.selectAllQueue.checked;
    });
    renderQueue();
  }

  async function recognizeSelected() {
    const selectedIds = state.queue
      .filter((item) => item.selected && item.status !== "processing")
      .map((item) => item.queueId);
    if (!selectedIds.length) return;
    if (!hasApiSettings()) {
      toast("請先完成 API 設定。", "error");
      route("settings");
      return;
    }

    els.recognizeSelected.disabled = true;
    for (const id of selectedIds) {
      await recognizeQueueItem(id);
    }
    toast(`已完成 ${selectedIds.length} 張名片辨識`);
  }

  async function recognizeQueueItem(queueId) {
    const item = state.queue.find((entry) => entry.queueId === queueId);
    if (!item) return;
    if (!hasApiSettings()) {
      item.status = "error";
      item.error = "尚未完成 API 設定";
      await persistQueueState(item);
      renderQueue();
      if (state.mode === "auto") {
        toast("自動拍攝完成，但需要先設定 API 才能辨識。", "error");
        route("settings");
      }
      return;
    }

    item.status = "processing";
    item.error = "";
    renderQueue();
    await persistQueueState(item);
    try {
      const result = await recognizeCard(item.croppedImage);
      item.status = "success";
      item.contact = normalizeContact(result.contact);
      item.rawResponse = result.rawResponse;
      item.selected = false;
    } catch (error) {
      item.status = "error";
      item.error = friendlyApiError(error);
      toast(`辨識失敗：${item.error}`, "error");
    }
    await persistQueueState(item);
    renderQueue();
  }

  async function persistQueueState(item) {
    try {
      await persistQueueItem(item);
      await refreshCards();
      return true;
    } catch (error) {
      toast(`IndexedDB 儲存失敗：${error.message}`, "error");
      return false;
    }
  }

  function hasApiSettings() {
    const settings = getSettings();
    return Boolean(settings.apiBaseUrl && settings.model && settings.apiKey);
  }

  async function recognizeCard(blob) {
    const settings = getSettings();
    const imageDataUrl = await blobToDataUrl(blob);
    const prompt = [
      "你是名片 OCR 與聯絡資料擷取助手。",
      "只回傳一個合法 JSON object，不要 Markdown、不要解釋。",
      "欄位必須固定為：name, company, title, phone, mobile, email, address, notes。",
      "無法辨識的欄位使用空字串；保留原文語言；多個值以「 / 」分隔。",
      "phone 放公司或室內電話，mobile 放行動電話，其他資訊放 notes。",
    ].join("\n");
    const body = {
      model: settings.model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } },
          ],
        },
      ],
      temperature: 1,
      max_tokens: 700,
      response_format: { type: "json_object" },
    };

    let response = await callChatCompletions(settings, body);
    if (!response.ok && [400, 404, 422].includes(response.status)) {
      const fallbackBody = { ...body };
      delete fallbackBody.response_format;
      response = await callChatCompletions(settings, fallbackBody);
    }
    if (!response.ok) throw new Error(await readApiError(response));

    const payload = await response.json();
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("API 沒有回傳辨識內容");
    const rawText = typeof content === "string" ? content : extractTextContent(content);
    return { contact: parseJsonResponse(rawText), rawResponse: rawText };
  }

  async function callChatCompletions(settings, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      return await fetch(`${settings.apiBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  function extractTextContent(content) {
    if (!Array.isArray(content)) return String(content || "");
    return content
      .map((part) => (typeof part === "string" ? part : part.text || ""))
      .join("");
  }

  function parseJsonResponse(text) {
    const cleaned = String(text)
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    try {
      return JSON.parse(cleaned);
    } catch {
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
      throw new Error("模型回傳的內容不是有效 JSON");
    }
  }

  function normalizeContact(contact = {}) {
    return CONTACT_FIELDS.reduce((result, field) => {
      const value = contact[field];
      result[field] = Array.isArray(value)
        ? value.filter(Boolean).join(" / ")
        : value == null
          ? ""
          : String(value).trim();
      return result;
    }, {});
  }

  async function persistQueueItem(item) {
    await ensureDatabase();
    const record = {
      id: item.recordId || createId(),
      capturedAt: item.capturedAt,
      mode: item.mode,
      status: item.status,
      originalImage: item.originalImage,
      croppedImage: item.croppedImage,
      annotatedImage: item.annotatedImage,
      boundingBox: item.boundingBox,
      corners: item.corners,
      cropMethod: item.cropMethod || "bounding-box",
      captureGroupId: item.captureGroupId || null,
      cardIndex: item.cardIndex || null,
      cardCount: item.cardCount || null,
      detectionMetrics: item.detectionMetrics || null,
      imageWidth: item.imageWidth,
      imageHeight: item.imageHeight,
      contact: normalizeContact(item.contact),
      rawResponse: item.rawResponse || "",
      model: getSettings().model,
      error: item.error || "",
    };
    await dbRequest("put", record);
    item.recordId = record.id;
  }

  function renderLibrary() {
    if (!els.libraryGrid) return;
    const search = els.librarySearch.value.trim().toLocaleLowerCase();
    const mode = els.modeFilter.value;
    const sort = els.sortOrder.value;
    const filtered = state.cards
      .filter((card) => mode === "all" || card.mode === mode)
      .filter((card) => {
        if (!search) return true;
        return Object.values(card.contact || {}).join(" ").toLocaleLowerCase().includes(search);
      })
      .sort((a, b) => {
        if (sort === "oldest") return a.capturedAt.localeCompare(b.capturedAt);
        if (sort === "name") {
          return (a.contact?.name || "").localeCompare(b.contact?.name || "", "zh-Hant");
        }
        return b.capturedAt.localeCompare(a.capturedAt);
      });

    els.libraryGrid.innerHTML = filtered
      .map((card) => {
        const imageUrl = makeObjectUrl(card.annotatedImage);
        const contact = normalizeContact(card.contact);
        const statusText =
          card.status === "success"
            ? card.mode === "auto"
              ? "自動辨識"
              : "手動辨識"
            : STATUS_LABELS[card.status] || "已儲存";
        const companyText =
          card.status === "error"
            ? `辨識失敗：${card.error || "可稍後重試"}`
            : [contact.company, contact.title].filter(Boolean).join("・") || "等待辨識";
        return `
          <article class="contact-card" data-id="${card.id}">
            <div class="contact-image-wrap">
              <img class="contact-image" src="${imageUrl}" alt="${escapeHtml(contact.name || "未命名名片")}的名片標示照片" />
              <span class="mode-label">${escapeHtml(statusText)}</span>
            </div>
            <div class="contact-body">
              <div class="contact-name-row">
                <h2>${escapeHtml(contact.name || "未辨識姓名")}</h2>
                <span>${escapeHtml(formatDate(card.capturedAt))}</span>
              </div>
              <p class="contact-company">${escapeHtml(companyText)}</p>
              <div class="contact-lines">
                <span>${escapeHtml(contact.email || "未提供 Email")}</span>
                <span>${escapeHtml(contact.mobile || contact.phone || "未提供電話")}</span>
              </div>
              <div class="contact-actions">
                <button class="button secondary" data-action="detail" type="button">查看完整資料</button>
                <button class="button danger" data-action="delete" type="button">刪除</button>
              </div>
            </div>
          </article>`;
      })
      .join("");
    els.libraryEmpty.classList.toggle("visible", filtered.length === 0);
    els.exportButton.disabled = state.cards.length === 0;
  }

  function handleLibraryClick(event) {
    const cardElement = event.target.closest(".contact-card");
    if (!cardElement) return;
    const card = state.cards.find((entry) => entry.id === cardElement.dataset.id);
    if (!card) return;
    const action = event.target.dataset.action;
    if (action === "detail") showCardDetail(card);
    if (action === "delete") requestDeleteCard(card);
  }

  function showCardDetail(card) {
    const contact = normalizeContact(card.contact);
    const imageUrl = makeObjectUrl(card.annotatedImage);
    const fields = [
      ["職稱", contact.title],
      ["電話", contact.phone],
      ["手機", contact.mobile],
      ["Email", contact.email],
      ["地址", contact.address],
      ["其他備註", contact.notes],
    ];
    els.detailContent.innerHTML = `
      <div class="detail-layout">
        <div class="detail-image"><img src="${imageUrl}" alt="帶有偵測框的名片照片" /></div>
        <div class="detail-info">
          <p class="eyebrow">CONTACT DETAIL</p>
          <h2>${escapeHtml(contact.name || "未辨識姓名")}</h2>
          <p class="company">${escapeHtml(contact.company || "未辨識公司")}</p>
          <div class="detail-fields">
            ${fields
              .map(
                ([label, value]) => `
                  <div class="detail-field">
                    <small>${label}</small>
                    <strong>${escapeHtml(value || "—")}</strong>
                  </div>`,
              )
              .join("")}
          </div>
          <div class="detail-meta">
            拍攝時間：${escapeHtml(formatDateTime(card.capturedAt))}<br />
            模式：${card.mode === "auto" ? "自動模式" : "手動模式"}<br />
            狀態：${escapeHtml(STATUS_LABELS[card.status] || card.status || "已儲存")}<br />
            Model：${escapeHtml(card.model || "—")}
            ${card.error ? `<br />錯誤：${escapeHtml(card.error)}` : ""}
          </div>
        </div>
      </div>`;
    els.detailDialog.showModal();
  }

  function requestDeleteCard(card) {
    const name = card.contact?.name || "這張名片";
    showConfirm(
      "刪除名片",
      `確定要永久刪除「${name}」的照片與聯絡資料嗎？`,
      async () => {
        await dbRequest("delete", card.id);
        await refreshCards();
        toast("名片已刪除");
      },
    );
  }

  function requestClearQueue() {
    if (!state.queue.length) return;
    showConfirm("清空處理佇列", "這會移除所有尚在佇列中的照片，已存入名片庫的資料不受影響。", () => {
      state.queue = [];
      renderQueue();
      toast("處理佇列已清空");
    });
  }

  function requestDeleteAllData() {
    showConfirm(
      "刪除所有本機資料",
      "此操作無法復原。所有名片照片、辨識結果與處理佇列都會永久刪除；API 設定會保留。",
      async () => {
        await dbRequest("clear");
        state.queue = [];
        renderQueue();
        await refreshCards();
        toast("所有名片資料已刪除");
      },
    );
  }

  function showConfirm(title, message, action) {
    els.confirmTitle.textContent = title;
    els.confirmMessage.textContent = message;
    state.confirmAction = action;
    els.confirmDialog.showModal();
  }

  function exportExcel() {
    if (!state.cards.length) {
      toast("目前沒有可匯出的名片。", "error");
      return;
    }
    if (!window.XLSX) {
      toast("本機 Excel 匯出元件無法載入，請確認 vendor 檔案完整。", "error");
      return;
    }
    const rows = state.cards.map((card) => {
      const contact = normalizeContact(card.contact);
      return {
        姓名: contact.name,
        公司: contact.company,
        職稱: contact.title,
        電話: contact.phone,
        手機: contact.mobile,
        Email: contact.email,
        地址: contact.address,
        其他備註: contact.notes,
        拍攝時間: formatDateTime(card.capturedAt),
        模式: card.mode === "auto" ? "自動模式" : "手動模式",
        狀態: STATUS_LABELS[card.status] || card.status || "",
        錯誤: card.error || "",
        Model: card.model || "",
        imageRecordId: card.id,
      };
    });
    const worksheet = XLSX.utils.json_to_sheet(rows);
    worksheet["!cols"] = [
      { wch: 16 },
      { wch: 26 },
      { wch: 20 },
      { wch: 18 },
      { wch: 18 },
      { wch: 30 },
      { wch: 42 },
      { wch: 36 },
      { wch: 22 },
      { wch: 12 },
      { wch: 16 },
      { wch: 40 },
      { wch: 18 },
      { wch: 38 },
    ];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "名片資料");
    XLSX.writeFile(workbook, `CardLens_${localDateStamp()}.xlsx`);
    toast(`已匯出 ${rows.length} 筆名片資料`);
  }

  async function readApiError(response) {
    try {
      const data = await response.json();
      return data.error?.message || data.message || `API 錯誤（${response.status}）`;
    } catch {
      return `API 錯誤（${response.status}）`;
    }
  }

  function friendlyApiError(error) {
    if (error.name === "AbortError") return "請求逾時，請稍後重試";
    if (error instanceof TypeError && /fetch/i.test(error.message)) {
      return "瀏覽器無法連線，請檢查網路、API URL 或 CORS 設定";
    }
    return error.message || "發生未知錯誤";
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  function makeObjectUrl(blob) {
    const cached = state.objectUrlCache.get(blob);
    if (cached) return cached;
    const url = URL.createObjectURL(blob);
    state.objectUrlCache.set(blob, url);
    state.objectUrls.add(url);
    return url;
  }

  function revokeObjectUrls() {
    state.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    state.objectUrls.clear();
    state.objectUrlCache = new WeakMap();
  }

  function toast(message, type = "success") {
    const element = document.createElement("div");
    element.className = `toast ${type}`;
    element.textContent = message;
    els.toastRegion.append(element);
    setTimeout(() => element.remove(), 4200);
  }

  function formatTime(iso) {
    return new Intl.DateTimeFormat("zh-TW", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));
  }

  function formatDate(iso) {
    return new Intl.DateTimeFormat("zh-TW", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(iso));
  }

  function formatDateTime(iso) {
    return new Intl.DateTimeFormat("zh-TW", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));
  }

  function localDateStamp() {
    const now = new Date();
    const parts = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((part) =>
      String(part).padStart(2, "0"),
    );
    return parts.join("");
  }

  function createId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `card-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function cleanup() {
    stopCamera();
    revokeObjectUrls();
    state.db?.close();
  }
})();
