import { Language } from "../../Domain/ProductLineEngineering/Entities/Language";
import { BUNDLED_SPL_MAPPING_LANGUAGE } from "../../generated/splBundledLanguage";

const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const LEGACY_MAPPING_LANGUAGE = "DSPL Deployment Mapping v1";

/** The mapping language is part of the regular application. The Portal project
 * and feature model remain optional fixtures. */
export function bundledSplLanguages(): Language[] {
  return [copy(BUNDLED_SPL_MAPPING_LANGUAGE)] as unknown as Language[];
}

export function withBundledSplLanguages(languages: Language[] | undefined): Language[] {
  const result = [...(languages || [])].filter((language) => language.name !== LEGACY_MAPPING_LANGUAGE);
  bundledSplLanguages().forEach((bundled) => {
    if (!result.some((language) => language.name === bundled.name)) result.push(bundled);
  });
  return result;
}
