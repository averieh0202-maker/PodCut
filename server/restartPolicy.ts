/** Shared rules are read from the installed skill, not a separate stale prompt. */
import { podcastSkill } from './podcastSkill';
export const restartPolicy = podcastSkill().rules;
