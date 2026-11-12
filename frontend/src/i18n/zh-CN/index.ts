import { zhCNCatalog } from './catalog';
import { zhCNCore } from './core';
import { zhCNOperations } from './operations';
import { zhCNTasks } from './tasks';
import { zhTaskTiming } from '../taskTiming';

export const zhCN: Record<string, string> = {
  ...zhCNCore,
  ...zhCNCatalog,
  ...zhCNTasks,
  ...zhTaskTiming,
  ...zhCNOperations,
  'language.label': '语言',
  'language.english': '英语',
  'language.spanish': '西班牙语',
  'language.chineseSimplified': '简体中文',
};
