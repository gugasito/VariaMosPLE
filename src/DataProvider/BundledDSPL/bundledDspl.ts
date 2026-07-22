import { Language } from "../../Domain/ProductLineEngineering/Entities/Language";
import { BUNDLED_DSPL_MAPPING_LANGUAGE } from "../../generated/dsplBundledLanguage";

const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** El lenguaje de mapping forma parte de la aplicación normal. El proyecto y
 * el feature model del Portal siguen siendo fixtures opcionales. */
export function bundledDsplLanguages(): Language[] {
  return [copy(BUNDLED_DSPL_MAPPING_LANGUAGE)] as unknown as Language[];
}

export function withBundledDsplLanguages(languages: Language[] | undefined): Language[] {
  const result = [...(languages || [])];
  bundledDsplLanguages().forEach((bundled) => {
    if (!result.some((language) => language.name === bundled.name)) result.push(bundled);
  });
  return result;
}
