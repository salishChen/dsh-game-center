/** Platform-owned binding UI: the iframe can never inject provider credentials or claim a model.
 * @param {{session:any,getService:()=>any,onSelected:()=>void,onExit:()=>void}} props */
export function ArenaOpponentPicker({ session, getService, onSelected, onExit }: {
    session: any;
    getService: () => any;
    onSelected: () => void;
    onExit: () => void;
}): any;
