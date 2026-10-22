// idiomorph ships JavaScript only: the part of its API the live refresh uses (src/ui/client/live.ts)
declare module "idiomorph" {
  export interface IdiomorphCallbacks {
    beforeNodeMorphed?: (oldNode: Node, newNode: Node) => boolean | undefined;
    beforeAttributeUpdated?: (
      attributeName: string,
      node: Element,
      mutationType: "update" | "remove",
    ) => boolean | undefined;
  }
  export interface IdiomorphOptions {
    morphStyle?: "outerHTML" | "innerHTML";
    ignoreActive?: boolean;
    ignoreActiveValue?: boolean;
    restoreFocus?: boolean;
    callbacks?: IdiomorphCallbacks;
  }
  export const Idiomorph: {
    morph(oldNode: Element, newContent: Element | string, options?: IdiomorphOptions): Node[] | undefined;
  };
}
