/**
 * MetricsEngine
 * Calculates composite metrics (TES, Seek-back Rate) based on the event stream.
 */
class MetricsEngine {
    constructor() {
        this.metrics = {
            seekBackCount: 0,
            seekBackRate: 0, // per minute (projected)
            trueEngagementScore: 0,
            playbackSpeedPenaltyCount: 0,
            dropOffTime: null,
            interactionCount: 0,
            totalPlayTime: 0
        };

        // Internal state
        this.totalDuration = 0; // Video duration
        this.lastUpdateTime = null;
        this.currentRate = 1.0;
        this.isDisconnecting = false; // Heartbeat check
    }

    /**
     * Process a new event from the tracker
     * @param {Object} event The JSON schema event
     */
    processEvent(event) {
        const payload = event.payload;
        this.totalDuration = payload.video_duration || this.totalDuration;

        // Update TES based on time passed between events if playing
        this._updateTES(event);

        switch (event.event_name) {
            case 'seek':
                this._analyzeSeek(payload.seek_from, payload.seek_to);
                break;
            case 'rate_change':
                this.currentRate = payload.playback_rate || 1.0;
                if (this.currentRate >= 2.0) {
                    this.metrics.playbackSpeedPenaltyCount++;
                }
                break;
            case 'download_attachment':
            case 'click_related_link':
                this.metrics.interactionCount++;
                break;
            case 'complete':
                // Finalize TES?
                break;
        }

        // Always update last active time for Drop-off logic
        if (payload.video_current_time) {
            this.metrics.dropOffTime = payload.video_current_time;
        }

        this.lastUpdateTime = new Date(event.timestamp).getTime();
    }

    /**
     * Logic for Seek-back Rate
     * Rewind > 5 seconds is interest.
     */
    _analyzeSeek(from, to) {
        const delta = to - from;
        // Seek Back logic: Delta is negative and magnitude > 5s
        if (delta < -5) {
            this.metrics.seekBackCount++;
            console.log('Detected Interest: Seek Back', delta);
        }

        // Note: Simple Seek Forward logic could be implemented here as negative signal
    }

    /**
     * True Engagement Score Update
     * TES = Accumulated Time * Speed Weight
     */
    _updateTES(event) {
        // We need a tick mechanism or rely on events. 
        // For accurate TES, we should hook into the video 'timeupdate' separately or 
        // calculate delta from previous event timestamp if the state was 'playing'.
        // However, 'timeupdate' is frequent. Let's rely on an external ticker or 
        // assume the UI calls `tick()` periodically.
    }

    /**
     * Called periodically (e.g. every second) by the main loop to accumulate TES
     * Only call this if the video is playing
     */
    tick(isPlaying, videoCurrentTime, playbackRate) {
        if (!isPlaying) return;

        // Weight Logic
        let weight = 1.0;
        if (playbackRate === 1.5) weight = 0.8;
        if (playbackRate >= 2.0) weight = 0.3; // Penalty

        // Accumulate (assuming 1 tick = 1 second roughly, or pass delta)
        // For better precision, pass deltaMs
        const timeValue = 1 * weight; // 1 second * weight

        this.metrics.trueEngagementScore += timeValue;
        this.metrics.totalPlayTime += 1;

        // Update Seek Back Rate (events / total playtime mins)
        // Avoid division by zero
        const mins = this.metrics.totalPlayTime / 60;
        if (mins > 0) {
            this.metrics.seekBackRate = (this.metrics.seekBackCount / mins).toFixed(2);
        }
    }

    getMetrics() {
        return this.metrics;
    }
}
