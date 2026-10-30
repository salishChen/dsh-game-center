/** Presentation only: approval/installation/launch remain in Host and Overlay.
 * @param {{entries:any[],previews:any[],fixture:boolean,hiddenCount:number,loading:boolean,refreshing:boolean,error:string|null,installError:string|null,installingGameId:string|null,scannedAt:string|null,stale:boolean,onRefresh:()=>void,onInstall:(entry:any)=>void,onLaunch:(entry:any)=>void,onPreview:(entry:any)=>void}} props */
export function GameLibrary(props: {
    entries: any[];
    previews: any[];
    fixture: boolean;
    hiddenCount: number;
    loading: boolean;
    refreshing: boolean;
    error: string | null;
    installError: string | null;
    installingGameId: string | null;
    scannedAt: string | null;
    stale: boolean;
    onRefresh: () => void;
    onInstall: (entry: any) => void;
    onLaunch: (entry: any) => void;
    onPreview: (entry: any) => void;
}): any;
