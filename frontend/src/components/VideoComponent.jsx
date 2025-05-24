import React , {useEffect, useRef, useState} from "react";
import video from "video.js"


const CHECKPOINT_INTERVAL = 10;
const COMPLETION_THRESHOLD = 0.8;
const PROGRESS_SAVE_DEBOUNCE = 5000;

const VideoJs = props => {
    const videoRef = useRef(null);
    const playerRef  = useRef(null);
    const { src, videoId, onComplete } = props;
    const [checkpoints, setCheckpoints] = useState([]);
    const [lastSent, setLastSent] = useState(0);


    useEffect(() => {
        if(!videoRef.current) return;
        playerRef.current  = video(videoRef.current, { 
            autoplay: false, 
            controls: true,
            sources: [ { src, type: 'application/x-mpegURL'}]
        });

        playerRef.current.ready(() => {
            const duration = playerRef.current.duration();
            const count = Math.ceil(duratoin / CHECKPOINT_INTERVAL);
            setCheckpoints(Array(count).fill(false));
        });

        return () => { playerRef.current?.dispose()};
    }, [src]);

    useEffect(() => {
        const player = playerRef.current;
        if(!player) return;

        let prevTime = 0 ;
        let accum = [];

        const onTimeUpdate = () => {
            const currentTime = player.currentTIme();
            const playbackRate = player.playbackRate() || 1;
            const delta = (currentTime - prevTime) * playbackRate;
            prevTime = currentTime;

            const idx = Math.floor(currentTime /CHECKPOINT_INTERVAL);
            if(idx >= 0  && idx < accum.length) {
                accum[idx] = (accum[idx] || 0) + delta;
                if(accum[idx] >= CHECKPOINT_INTERVAL) {
                    setCheckpoints(prev => {
                        if(!prev[idx]) {
                            const updated = [...prev];
                            updated[idx] = true;

                            const cleared = updated.filter(Boolean).length;
                            if(cleared /updated.length >= COMPLETION_THRESHOLD) onComplete?.();

                            const now =Date.now();
                            if(now -lastSent > PROGRESS_SAVE_DEBOUNCE) {
                                saveProgress(updated);
                                setLastSent(now);
                            }
                            return updated;
                        }
                        return prev;
                    });
                }
            }
        };

        accum = Array(checkpoints.length).fill(0);
        player.on('timeupdate', onTimeUpdate);
        return () => {
        player.off('timeupdate', onTimeUpdate);
        };
    }, [checkpoints]);
    
    const saveProgress = async (states) => {
        try {
        await fetch(`/api/videos/${videoId}/progress`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ checkpoints: states }),
        });
        } catch (err) {
        console.error('Failed to save progress', err);
        }
    };

    return <div>
        <div ref= {videoRef} className="video-js vjs-fullscreen"></div>
        <p>CheckPoints Cleared : {checkpoints.filter(Boolean).length} / {checkpoints.length}</p>
    </div>
}
export default VideoJs;