import { MATCH_STATUS } from "../validation/matches.js";

type MatchStatus = (typeof MATCH_STATUS)[keyof typeof MATCH_STATUS];

interface MatchWithStatus {
    id: number;
    startTime: string;
    endTime: string;
    status: MatchStatus;
}

type UpdateMatchStatus = (id: number, status: MatchStatus) => Promise<void>;

export function getMatchStatus(startTime: string, endTime: string, now: Date = new Date()): MatchStatus | null {
    
    const start = new Date(startTime);
    const end = new Date(endTime);

    if(Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        return null;
    }

    if (now < start) {
        return MATCH_STATUS.SCHEDULED;
    } else if (now >= start && now <= end) {
        return MATCH_STATUS.LIVE;
    } else {
        return MATCH_STATUS.FINISHED;
    }
}


export async function syncMatchStatus(match: MatchWithStatus, updateMatchStatus: UpdateMatchStatus): Promise<MatchStatus> {

    const nextStatus = getMatchStatus(match.startTime, match.endTime);

    if(!nextStatus){
        return match.status;
    }

    if (match.status !== nextStatus) {
        await updateMatchStatus(match.id, nextStatus);
    }

    return nextStatus;
}