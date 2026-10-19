import type {
  DefaultResourceLoader,
  Skill,
} from '@earendil-works/pi-coding-agent';
import {decideAgentPermission, type AgentPolicyProfile} from './policy.ts';

type ResourceOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];
type SkillsOverride = NonNullable<ResourceOptions['skillsOverride']>;

/** Hide denied skills while retaining their paths for explicit invocation checks. */
export function createAgentResourcePolicy(profile: AgentPolicyProfile = {}) {
  const policy: AgentPolicyProfile = {
    permissions: profile.permissions?.map(rule => ({...rule})),
  };
  let discovered: readonly Skill[] = [];

  function resourceOptions(): {skillsOverride: SkillsOverride};
  function resourceOptions<T extends Partial<ResourceOptions>>(
    options: T,
  ): T & {skillsOverride: SkillsOverride};
  function resourceOptions(options: Partial<ResourceOptions> = {}) {
    const previous = options.skillsOverride;
    return {
      ...options,
      skillsOverride(base: Parameters<SkillsOverride>[0]) {
        const result = previous?.(base) ?? base;
        discovered = Object.freeze([...result.skills]);
        if (!policy.permissions?.length) return result;
        const skills = result.skills.filter(
          skill =>
            decideAgentPermission(policy, 'skill', skill.name) !== 'deny',
        );
        return skills.length === result.skills.length
          ? result
          : {...result, skills};
      },
    };
  }

  return {resourceOptions, skills: () => discovered};
}
