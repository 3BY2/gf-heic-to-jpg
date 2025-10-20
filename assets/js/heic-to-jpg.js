// gf-heic-to-jpg — FINAL: capture-phase shim for GF multi-file + global plupload patch + native inputs
(function (window, $) {
  if (window.__GF_HEIC2JPG_INSTALLED__) return;
  window.__GF_HEIC2JPG_INSTALLED__ = true;

  const NS = '.gfheic';
  const CAPTURE_FLAG = '__heicCaptureHandled__';

  // ---------- helpers ----------
  function isHeicLike(fileish) {
    const name = (fileish && fileish.name ? String(fileish.name) : '').toLowerCase();
    const type = (fileish && fileish.type ? String(fileish.type) : '').toLowerCase();
    return (
      type === 'image/heic' ||
      type === 'image/heif' ||
      type === 'image/heic-sequence' ||
      name.endsWith('.heic') ||
      name.endsWith('.heif')
    );
  }
  function toJpegName(name) {
    return String(name).replace(/\.heic$/i, '.jpg').replace(/\.heif$/i, '.jpg');
  }
  function normalizeToBlob(result) {
    return result instanceof Blob ? result : new Blob([result], { type: 'image/jpeg' });
  }
  async function convertNativeToJpeg(nativeFile) {
    if (typeof window.heic2any !== 'function') throw new Error('heic2any not loaded');
    const out = await window.heic2any({ blob: nativeFile, toType: 'image/jpeg', quality: 0.8 });
    const blob = normalizeToBlob(out);
    return new File([blob], toJpegName(nativeFile.name), {
      type: 'image/jpeg',
      lastModified: Date.now()
    });
  }

  // ---------- CAPTURE-PHASE INTERCEPTOR for mOxie shim inputs (GF multi-file) ----------
  function bindCaptureForMoxieFileInputs() {
    // We attach ONE capture listener at the document level.
    // It will run BEFORE Plupload/mOxie handlers and let us rewrite the FileList.
    document.addEventListener('change', async function (e) {
      const el = e.target;
      if (!(el instanceof HTMLInputElement)) return;
      if (el.type !== 'file') return;
      // Only target GF multi-file shims (they live inside .moxie-shim HTML5 wrappers)
      // and only if multiple selection is enabled (multi-upload fields)
      const isMoxieShim = !!el.closest('.moxie-shim-html5');
      if (!isMoxieShim || !el.multiple) return;

      // Guard to avoid infinite loops when we dispatch our synthetic change later
      if (el[CAPTURE_FLAG] === '1') return;

      const files = Array.from(el.files || []);
      if (!files.length) return;

      // Do we have any HEIC/HEIF?
      const heicIdx = files.reduce((acc, f, i) => (isHeicLike(f) ? (acc.push(i), acc) : acc), []);
      if (heicIdx.length === 0) return;

      // Stop Plupload from seeing the original HEIC selection
      e.stopImmediatePropagation();
      e.preventDefault();

      try {
        // Convert all HEICs in the selection (others pass through)
        const converted = await Promise.all(
          files.map(f => (isHeicLike(f) ? convertNativeToJpeg(f).catch(() => f) : Promise.resolve(f)))
        );

        // Replace the input’s FileList with our JPEGs
        try {
          const dt = new DataTransfer();
          converted.forEach(f => dt.items.add(f));
          el.files = dt.files;
        } catch (err) {
          // If the browser doesn't allow replacing, just fall back (uploads continue as-is)
          console.warn('[gfHeicToJpg] Browser prevented FileList replacement on shim input.', err);
        }

        // Mark and re-dispatch a fresh bubbling change so Plupload queues the JPEGs
        el[CAPTURE_FLAG] = '1';
        const evt = new Event('change', { bubbles: true });
        el.dispatchEvent(evt);
        // Clear the flag shortly after to allow future selections
        setTimeout(() => { try { el[CAPTURE_FLAG] = ''; } catch (_) {} }, 0);
      } catch (err) {
        // On failure, allow original event to bubble by manually re-dispatching it unchanged
        console.warn('[gfHeicToJpg] HEIC conversion failed during capture; passing originals.', err);
        el[CAPTURE_FLAG] = '1';
        el.dispatchEvent(new Event('change', { bubbles: true }));
        setTimeout(() => { try { el[CAPTURE_FLAG] = ''; } catch (_) {} }, 0);
      }
    }, true); // <-- CAPTURE!
  }

  // ---------- Native <input type="file"> path (non-Plupload fields) ----------
  function bindNativeInputs() {
    $(document)
      .off('change' + NS, 'input[type="file"]:not(.gform_button_select_files)')
      .on('change' + NS, 'input[type="file"]:not(.gform_button_select_files)', function (e) {
        const input = e.target;
        if (input.dataset.heicProcessing === '1') return;
        input.dataset.heicProcessing = '1';

        const files = Array.from(input.files || []);
        if (!files.length) { input.dataset.heicProcessing = ''; return; }

        const tasks = files.map(f => (isHeicLike(f) ? convertNativeToJpeg(f).catch(() => f) : Promise.resolve(f)));
        Promise.all(tasks).then(out => {
          try {
            const dt = new DataTransfer();
            out.forEach(f => dt.items.add(f));
            input.files = dt.files;
            console.log(`[gfHeicToJpg] Native input replaced (${out.length} files).`);
          } catch (err) {
            console.warn('[gfHeicToJpg] DataTransfer unsupported for native input replace.', err);
          } finally {
            input.dataset.heicProcessing = '';
          }
        }).catch(() => { input.dataset.heicProcessing = ''; });
      });
  }

  // ---------- Optional: keep global Plupload addFile patch as a safety net ----------
  function patchPluploadAddFileOnce() {
    const plu = window.plupload;
    if (!plu || !plu.Uploader || plu.Uploader.__gfHeicPatchedAddFile) return;
    plu.Uploader.__gfHeicPatchedAddFile = true;

    const U = plu.Uploader.prototype;
    const origAddFile = U.addFile;

    function addLater(up, fileObj) {
      try { origAddFile.call(up, fileObj, fileObj && fileObj.name); }
      catch (e) { const blob = fileObj instanceof File ? fileObj : fileObj.slice(0, fileObj.size, 'image/jpeg'); origAddFile.call(up, blob, fileObj && fileObj.name); }
      try { up.refresh(); } catch (_) {}
      try { up.trigger && up.trigger('QueueChanged'); } catch (_) {}
    }

    U.addFile = function (file, fileName) {
      const up = this;
      if (up.runtime && up.runtime !== 'html5') return origAddFile.apply(up, arguments);

      if (Array.isArray(file)) {
        file.forEach(f => origAddFile.call(up, f, (f && f.name) || fileName));
        return;
      }
      return origAddFile.call(up, file, (file && file.name) || fileName);
    };
  }

  // ---------- Public API ----------
  window.gfHeicToJpg = {
    init: function () {
      console.log('gfHeicToJpg initialized (capture-phase shim + safety nets)');
      bindCaptureForMoxieFileInputs(); // key piece for GF multi-file
      bindNativeInputs();              // non-Plupload fields
      if (window.plupload && window.plupload.Uploader) patchPluploadAddFileOnce();
      // If plupload loads later, patch then (not strictly needed for the capture shim)
      if (!window.plupload || !window.plupload.Uploader) {
        const obs = new MutationObserver(() => {
          if (window.plupload && window.plupload.Uploader) {
            patchPluploadAddFileOnce();
            obs.disconnect();
          }
        });
        obs.observe(document.documentElement, { childList: true, subtree: true });
      }
    },
    showNotification: function (input, message, type) {
      if (!window.jQuery) return;
      var $input = jQuery(input);
      var $note = jQuery(
        '<div class="gf-heic-notification ' + type + '">' +
          (type === 'success'
            ? '<span class="icon success-icon">&#10003;</span> '
            : '<span class="icon error-icon">&#10060;</span>') +
          message +
          '</div>'
      );
      $note.insertAfter($input).addClass('show');
      setTimeout(function () {
        $note.fadeOut(400, function () { jQuery(this).remove(); });
      }, 5000);
    }
  };

  // Auto-init
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', window.gfHeicToJpg.init, { once: true });
  } else {
    try { window.gfHeicToJpg.init(); } catch (e) {}
  }
})(window, jQuery);
