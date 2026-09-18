/* ==========================================================================
   Uploading a photo — one implementation
   --------------------------------------------------------------------------
   The listing form grew a signed Cloudinary upload; the guide record still
   asked for a URL and expected somebody to have hosted the photograph
   somewhere first. That is not a thing a tourism officer can reasonably be
   asked to do, and it is why guide photos were mostly empty.

   Rather than give the guides page a second uploader, the listing form's one
   moved here and both call it.

   -- Signed, not unsigned --------------------------------------------------
   The server signs each upload at /api/uploads/signature, behind requireStaff.
   An unsigned preset is a public write endpoint: anyone who reads the page
   source can post to the municipality's media account. The signature is
   fetched once per dialog and reused, because it covers a folder and a
   timestamp rather than one file.

   If the server has no Cloudinary credentials configured it says so plainly,
   and the caller's unsigned preset is used instead — so uploads keep working
   while that is being set up rather than failing the day this ships.
   ========================================================================== */

(function () {
    'use strict';

    const MAX_BYTES = 10 * 1024 * 1024;

    function authHeaders(extra) {
        return Object.assign(
            { 'Authorization': 'Bearer ' + (localStorage.getItem('authToken') || '') },
            extra || {}
        );
    }

    /* One ticket per session of uploading, cleared by reset(). A dialog that
       opens, uploads, closes and reopens asks for a fresh one, because the
       signature carries a timestamp Cloudinary will eventually refuse. */
    let ticket = null;

    async function getTicket(apiBase) {
        if (ticket) return ticket;
        try {
            const response = await fetch((apiBase || '') + '/uploads/signature', { headers: authHeaders() });
            if (response.status === 401 || response.status === 403) {
                throw new Error('Your sign-in does not allow uploading photos. Sign in again and retry.');
            }
            if (!response.ok) throw new Error('Could not authorise the upload.');
            ticket = await response.json();
        } catch (error) {
            if (/sign-in/.test(error.message)) throw error;
            // A network blip should not close off the upload path entirely.
            ticket = { signed: false };
        }
        return ticket;
    }

    function reset() { ticket = null; }

    function configured(options) {
        const settings = options || {};
        return Boolean(settings.cloudName && settings.uploadPreset) &&
            !String(settings.cloudName).startsWith('YOUR_') &&
            !String(settings.uploadPreset).startsWith('YOUR_');
    }

    /**
     * Uploads one image and resolves to its URL.
     * options: { apiBase, cloudName, uploadPreset }
     */
    async function uploadImage(file, options) {
        const settings = options || {};

        // Checked here as well as by the accept attribute, which a determined
        // file picker will happily ignore.
        if (!file || !/^image\//.test(file.type || '')) {
            throw new Error('That is not an image.');
        }
        if (file.size > MAX_BYTES) {
            throw new Error('That photo is larger than 10MB. Please choose a smaller one.');
        }

        const pass = await getTicket(settings.apiBase);
        const body = new FormData();
        body.append('file', file);

        let cloudName = settings.cloudName;
        if (pass.signed) {
            cloudName = pass.cloudName;
            body.append('api_key', pass.apiKey);
            body.append('timestamp', pass.timestamp);
            body.append('folder', pass.folder);
            body.append('signature', pass.signature);
        } else {
            if (!configured(settings)) {
                throw new Error('Photo uploads are not configured yet. Ask the Tourism Office to finish setting up the media account.');
            }
            body.append('upload_preset', settings.uploadPreset);
        }

        const response = await fetch('https://api.cloudinary.com/v1_1/' + cloudName + '/image/upload', {
            method: 'POST', body: body
        });
        const result = await response.json().catch(function () { return {}; });
        if (!response.ok || !result.secure_url) {
            // A stale signature is worth one retry with a fresh one.
            if (pass.signed && response.status === 401) reset();
            throw new Error((result && result.error && result.error.message) || 'The upload was rejected.');
        }
        return result.secure_url;
    }

    window.ZTIMS_UPLOAD = {
        uploadImage: uploadImage,
        configured: configured,
        reset: reset,
        MAX_BYTES: MAX_BYTES
    };
})();
