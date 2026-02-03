/**
 * BehavioralTracker
 * Tracks user interactions and video playback events for behavioral interest analysis.
 * Adheres to the LMS User Behavioral Event Schema.
 */
class BehavioralTracker {
    constructor(config) {
        this.sessionId = config.sessionId || crypto.randomUUID();
        this.userId = config.userId || 'anonymous';
        this.debug = config.debug || false;

        // Callback for when an event is tracked
        this.onEventTracked = null;

        this.videoElement = null;
        this.sessionStartTime = new Date();

        // State for tracking seeking
        this.isSeeking = false;
        this.seekStartTime = 0;

        // Bind methods
        this._handlePlay = this._handlePlay.bind(this);
        this._handlePause = this._handlePause.bind(this);
        this._handleSeeking = this._handleSeeking.bind(this);
        this._handleSeeked = this._handleSeeked.bind(this);
        this._handleRateChange = this._handleRateChange.bind(this);
        this._handleEnded = this._handleEnded.bind(this);
    }

    /**
     * Attaches listeners to a video element
     * @param {HTMLVideoElement} videoElement 
     */
    attachToVideoElement(videoElement) {
        if (this.videoElement) {
            this._removeListeners();
        }
        this.videoElement = videoElement;

        this.videoElement.addEventListener('play', this._handlePlay);
        this.videoElement.addEventListener('pause', this._handlePause);
        this.videoElement.addEventListener('seeking', this._handleSeeking);
        this.videoElement.addEventListener('seeked', this._handleSeeked);
        this.videoElement.addEventListener('ratechange', this._handleRateChange);
        this.videoElement.addEventListener('ended', this._handleEnded);

        // Track initial Heartbeat / Pageview
        this.trackEvent('system_event', 'page_view', {
            url: window.location.href
        });
    }

    _removeListeners() {
        if (!this.videoElement) return;
        this.videoElement.removeEventListener('play', this._handlePlay);
        this.videoElement.removeEventListener('pause', this._handlePause);
        this.videoElement.removeEventListener('seeking', this._handleSeeking);
        this.videoElement.removeEventListener('seeked', this._handleSeeked);
        this.videoElement.removeEventListener('ratechange', this._handleRateChange);
        this.videoElement.removeEventListener('ended', this._handleEnded);
    }

    _createEventPayload(eventName, category, customPayload = {}) {
        const timestamp = new Date().toISOString();
        const basePayload = {
            event_id: crypto.randomUUID(),
            timestamp: timestamp,
            session_id: this.sessionId,
            user_id: this.userId,
            event_category: category,
            event_name: eventName,
            context: {
                page_url: window.location.href,
                user_agent: navigator.userAgent,
                device_type: this._getDeviceType()
            },
            payload: {
                ...customPayload
            }
        };

        if (this.videoElement) {
            basePayload.payload.video_current_time = this.videoElement.currentTime;
            basePayload.payload.video_duration = this.videoElement.duration;
            basePayload.payload.playback_rate = this.videoElement.playbackRate;
        }

        return basePayload;
    }

    trackEvent(category, eventName, payload = {}) {
        const eventData = this._createEventPayload(eventName, category, payload);

        if (this.debug) {
            console.log(`[Tracker] ${eventName}`, eventData);
        }

        if (this.onEventTracked) {
            this.onEventTracked(eventData);
        }

        return eventData;
    }

    // --- Event Handlers ---

    _handlePlay() {
        this.trackEvent('video_player_event', 'play');
    }

    _handlePause() {
        // Ignore pause if we are seeking (seeking triggers pause on some browsers)
        if (!this.isSeeking) {
            this.trackEvent('video_player_event', 'pause');
        }
    }

    _handleSeeking() {
        this.isSeeking = true;
        this.seekStartTime = this.videoElement.currentTime;
        // We don't track 'seeking' continuously, we wait for 'seeked' to calculate the delta
    }

    _handleSeeked() {
        if (this.isSeeking) {
            const seekEndTime = this.videoElement.currentTime;
            this.trackEvent('video_player_event', 'seek', {
                seek_from: this.seekStartTime,
                seek_to: seekEndTime
            });
            this.isSeeking = false;
        }
    }

    _handleRateChange() {
        this.trackEvent('video_player_event', 'rate_change', {
            playback_rate: this.videoElement.playbackRate
        });
    }

    _handleEnded() {
        this.trackEvent('video_player_event', 'complete');
    }

    /**
     * Track manual interactions like downloading attachments
     */
    trackInteraction(action, targetId, targetType) {
        this.trackEvent('interaction_event', action, {
            target_id: targetId,
            target_type: targetType
        });
    }

    _getDeviceType() {
        const ua = navigator.userAgent;
        if (/(tablet|ipad|playbook|silk)|(android(?!.*mobi))/i.test(ua)) {
            return "tablet";
        }
        if (/Mobile|Android|iP(hone|od)|IEMobile|BlackBerry|Kindle|Silk-Accelerated|(hpw|web)OS|Opera M(obi|ini)/.test(ua)) {
            return "mobile";
        }
        return "desktop";
    }
}
