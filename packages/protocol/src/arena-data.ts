/** Canonical local simulator data shared by the game and AI Host. Not native APK balance. */
export interface ArenaPart {id:string;kind:'body'|'wheel'|'weapon'|'gadget';name:string;tag:string;description:string;health?:number;power?:number;width?:number;height?:number;mass?:number;speed?:number;friction?:number;radius?:number;grip?:number;damage?:number;cooldown?:number;reach?:number;slots?:number;color?:string}
export interface ArenaSlot {id:string;label:string;kind:'wheel'|'weapon'|'gadget';x:number;y:number}
export const ARENA_PARTS:Record<string,ArenaPart>={
  "classic": {
    "id": "classic",
    "kind": "body",
    "name": "经典",
    "tag": "均衡",
    "health": 390,
    "power": 9,
    "width": 142,
    "height": 66,
    "mass": 8,
    "speed": 1,
    "color": "#dca84e",
    "slots": 2,
    "description": "血量最低，但是有很高的几率控制对手的战车。稳定。",
    "friction": 0.3
  },
  "sneaky": {
    "id": "sneaky",
    "kind": "body",
    "name": "滑头",
    "tag": "高速",
    "health": 310,
    "power": 11,
    "width": 164,
    "height": 48,
    "mass": 6,
    "speed": 1.2,
    "color": "#59aaa1",
    "slots": 2,
    "description": "机身较轻，便于跳跃、飞行和越过障碍。",
    "friction": 0.3
  },
  "titan": {
    "id": "titan",
    "kind": "body",
    "name": "泰坦",
    "tag": "高挂点",
    "health": 510,
    "power": 8,
    "width": 128,
    "height": 92,
    "mass": 11,
    "speed": 0.78,
    "color": "#b97857",
    "slots": 2,
    "description": "机身最重，血量厚。存在稳定性问题。",
    "friction": 0.3
  },
  "roller": {
    "id": "roller",
    "kind": "wheel",
    "name": "滚轮",
    "tag": "均衡",
    "health": 40,
    "radius": 23,
    "speed": 1,
    "grip": 0.95,
    "description": "功能最多的车轮。"
  },
  "bigfoot": {
    "id": "bigfoot",
    "kind": "wheel",
    "name": "大脚轮",
    "tag": "抓地",
    "health": 75,
    "radius": 31,
    "speed": 0.85,
    "grip": 1.4,
    "description": "尺寸最大、最强劲、血量最厚的车轮，但不适用于某些车身。"
  },
  "knob": {
    "id": "knob",
    "kind": "wheel",
    "name": "旋钮轮",
    "tag": "低底盘",
    "health": 25,
    "radius": 16,
    "speed": 1.2,
    "grip": 0.8,
    "description": "最小车轮。"
  },
  "blade": {
    "id": "blade",
    "kind": "weapon",
    "name": "圆锯",
    "tag": "近战",
    "power": 3,
    "damage": 33,
    "cooldown": 0.38,
    "reach": 79,
    "color": "#e7d8ac",
    "description": "旋转、击打。可打破气球。"
  },
  "chainsaw": {
    "id": "chainsaw",
    "kind": "weapon",
    "name": "电锯",
    "tag": "近战",
    "power": 4,
    "damage": 26,
    "cooldown": 0.25,
    "reach": 88,
    "color": "#d4b86b",
    "description": "近战武器，射程近，伤害大。"
  },
  "drill": {
    "id": "drill",
    "kind": "weapon",
    "name": "电钻",
    "tag": "穿刺",
    "power": 4,
    "damage": 64,
    "cooldown": 0.72,
    "reach": 104,
    "color": "#96afbd",
    "description": "近战武器，射程和伤害中等。"
  },
  "rocket": {
    "id": "rocket",
    "kind": "weapon",
    "name": "火箭",
    "tag": "远程",
    "power": 5,
    "damage": 90,
    "cooldown": 1.85,
    "reach": 1200,
    "color": "#d86448",
    "description": "远程武器，伤害较高。"
  },
  "laser": {
    "id": "laser",
    "kind": "weapon",
    "name": "激光",
    "tag": "蓄力",
    "power": 6,
    "damage": 156,
    "cooldown": 2.5,
    "reach": 1300,
    "color": "#69e0dc",
    "description": "远程武器，可在2.5秒内装填和射击，造成巨大伤害。"
  },
  "none": {
    "id": "none",
    "kind": "gadget",
    "name": "空置",
    "tag": "省电",
    "power": 0,
    "description": "为主武器保留电力。"
  },
  "booster": {
    "id": "booster",
    "kind": "gadget",
    "name": "推进器",
    "tag": "冲撞",
    "power": 2,
    "description": "使战车加速向前，然后失效。"
  },
  "repulse": {
    "id": "repulse",
    "kind": "gadget",
    "name": "反弹器",
    "tag": "击退",
    "power": 3,
    "description": "接触敌人后爆炸并将其抛回。"
  },
  "repair": {
    "id": "repair",
    "kind": "gadget",
    "name": "维修箱",
    "tag": "续航",
    "power": 2,
    "description": "当血量低于一半时开始治疗。可在几秒内治愈，随后失效。"
  }
}
export const ARENA_SLOTS:Record<string,ArenaSlot[]>={
  "classic": [
    {
      "id": "wheel-rear",
      "label": "后轮槽",
      "kind": "wheel",
      "x": -0.34,
      "y": 0.67
    },
    {
      "id": "wheel-front",
      "label": "前轮槽",
      "kind": "wheel",
      "x": 0.34,
      "y": 0.67
    },
    {
      "id": "weapon-front",
      "label": "前部武器槽",
      "kind": "weapon",
      "x": 0.45,
      "y": -0.02
    },
    {
      "id": "weapon-top",
      "label": "上部武器槽",
      "kind": "weapon",
      "x": 0.1,
      "y": -0.58
    },
    {
      "id": "gadget-front",
      "label": "前部辅助槽",
      "kind": "gadget",
      "x": 0.38,
      "y": -0.3
    },
    {
      "id": "gadget-rear",
      "label": "后部辅助槽",
      "kind": "gadget",
      "x": -0.33,
      "y": -0.34
    }
  ],
  "sneaky": [
    {
      "id": "wheel-rear",
      "label": "后轮槽",
      "kind": "wheel",
      "x": -0.36,
      "y": 0.7
    },
    {
      "id": "wheel-front",
      "label": "前轮槽",
      "kind": "wheel",
      "x": 0.34,
      "y": 0.7
    },
    {
      "id": "weapon-front",
      "label": "前部武器槽",
      "kind": "weapon",
      "x": 0.45,
      "y": -0.02
    },
    {
      "id": "weapon-top",
      "label": "上部武器槽",
      "kind": "weapon",
      "x": 0.08,
      "y": -0.58
    },
    {
      "id": "gadget-top",
      "label": "上部辅助槽",
      "kind": "gadget",
      "x": -0.1,
      "y": -0.55
    },
    {
      "id": "gadget-rear",
      "label": "后部辅助槽",
      "kind": "gadget",
      "x": -0.36,
      "y": -0.2
    }
  ],
  "titan": [
    {
      "id": "wheel-rear",
      "label": "后轮槽",
      "kind": "wheel",
      "x": -0.34,
      "y": 0.62
    },
    {
      "id": "wheel-front",
      "label": "前轮槽",
      "kind": "wheel",
      "x": 0.34,
      "y": 0.62
    },
    {
      "id": "weapon-front",
      "label": "前部武器槽",
      "kind": "weapon",
      "x": 0.45,
      "y": -0.02
    },
    {
      "id": "weapon-top",
      "label": "上部武器槽",
      "kind": "weapon",
      "x": 0.1,
      "y": -0.58
    },
    {
      "id": "gadget-front",
      "label": "前部辅助槽",
      "kind": "gadget",
      "x": 0.4,
      "y": 0.15
    },
    {
      "id": "gadget-top",
      "label": "上部辅助槽",
      "kind": "gadget",
      "x": -0.1,
      "y": -0.58
    },
    {
      "id": "gadget-rear",
      "label": "后部辅助槽",
      "kind": "gadget",
      "x": -0.38,
      "y": -0.2
    }
  ]
}
