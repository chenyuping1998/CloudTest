/**
 * 移動規則（伺服器與用戶端預測共用同一份，確保兩邊算出來的路線一致）：
 * 不能走進障礙 / 水；撞牆時沿牆滑動；往上最多爬 1 格。
 */
import type { Grid } from './grid';

export const MELEE_RANGE = 1.6;
export const RANGED_RANGE = 7;
export const INTERACT_RANGE = 2.4;

/** 玩家移動速度（格 / 秒）：AGI 越高越快 */
export function playerSpeed(agi: number): number {
  return 4.3 + agi * 0.01;
}

export interface MoveState {
  x: number;
  z: number;
  yaw: number;
  moving: boolean;
}

/**
 * 朝 (tx, tz) 前進一步，停在距離 stopAt 的地方。
 * @returns 是否已抵達（或被擋住無法再前進）
 */
export function stepToward(grid: Grid, e: MoveState, tx: number, tz: number, speed: number, dt: number, stopAt: number): boolean {
  const dx = tx - e.x;
  const dz = tz - e.z;
  const d = Math.hypot(dx, dz);
  if (d <= stopAt) return true;
  const step = Math.min(speed * dt, d - stopAt);
  let nx = e.x + (dx / d) * step;
  let nz = e.z + (dz / d) * step;
  if (!grid.walkable(nx, nz)) {
    if (grid.walkable(nx, e.z)) nz = e.z;
    else if (grid.walkable(e.x, nz)) nx = e.x;
    else return true;
  }
  if (grid.heightAt(nx, nz) - grid.heightAt(e.x, e.z) > 1.2) return true;
  e.x = nx;
  e.z = nz;
  e.yaw = Math.atan2(dx, dz);
  e.moving = true;
  return d - step <= stopAt + 1e-3;
}
