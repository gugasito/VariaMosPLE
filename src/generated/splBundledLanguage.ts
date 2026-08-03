/* SPL language bundled with the application. Generated from contracts/languages. */
export const BUNDLED_SPL_MAPPING_LANGUAGE = {
  "name": "SPL Deployment Mapping v1",
  "type": "APPLICATION",
  "stateAccept": "APPROVED",
  "abstractSyntax": {
    "elements": {
      "DeploymentMapping": {
        "properties": [
          {
            "name": "mapping_schema",
            "type": "String",
            "possibleValues": "spl-deployment-mapping/v1"
          },
          {
            "name": "mapping_ref",
            "type": "String"
          },
          {
            "name": "catalog_ref",
            "type": "String"
          },
          {
            "name": "target_ref",
            "type": "String"
          }
        ]
      },
      "FeatureBinding": {
        "properties": [
          {
            "name": "source_feature_id",
            "type": "String"
          },
          {
            "name": "feature_ref",
            "type": "String"
          }
        ]
      },
      "SoftwareArtifact": {
        "properties": [
          {
            "name": "artifact_ref",
            "type": "String"
          }
        ]
      }
    },
    "restrictions": {
      "quantity_element": [
        {
          "element": "DeploymentMapping",
          "min": 1,
          "max": 1
        }
      ]
    },
    "relationships": {
      "ContainsBinding": {
        "min": 0,
        "max": 9999999,
        "source": "DeploymentMapping",
        "target": [
          "FeatureBinding"
        ],
        "properties": []
      },
      "ContainsArtifact": {
        "min": 0,
        "max": 9999999,
        "source": "DeploymentMapping",
        "target": [
          "SoftwareArtifact"
        ],
        "properties": []
      },
      "ImplementedBy": {
        "min": 0,
        "max": 9999999,
        "source": "FeatureBinding",
        "target": [
          "SoftwareArtifact"
        ],
        "properties": []
      }
    }
  },
  "concreteSyntax": {
    "elements": {
      "DeploymentMapping": {
        "design": "shape=swimlane;fillColor=#dbeafe;strokeColor=#1d4ed8;fontStyle=1;",
        "label_property": "mapping_ref",
        "width": 240,
        "height": 120,
        "resizable": "true"
      },
      "FeatureBinding": {
        "design": "shape=rectangle;rounded=1;fillColor=#dcfce7;strokeColor=#15803d;",
        "label_property": "feature_ref",
        "width": 180,
        "height": 70,
        "resizable": "true"
      },
      "SoftwareArtifact": {
        "design": "shape=rectangle;rounded=1;fillColor=#ffedd5;strokeColor=#c2410c;",
        "label_property": "artifact_ref",
        "width": 200,
        "height": 70,
        "resizable": "true"
      }
    },
    "relationships": {
      "ContainsBinding": {
        "styles": [
          {
            "style": "strokeColor=#64748b;dashed=1;endArrow=open;"
          }
        ],
        "label_fixed": "contains"
      },
      "ContainsArtifact": {
        "styles": [
          {
            "style": "strokeColor=#64748b;dashed=1;endArrow=open;"
          }
        ],
        "label_fixed": "contains"
      },
      "ImplementedBy": {
        "styles": [
          {
            "style": "strokeColor=#2563eb;strokeWidth=2;endArrow=block;"
          }
        ],
        "label_fixed": "implementa"
      }
    }
  },
  "semantics": {
    "elementTypes": [],
    "elementTranslationRules": {},
    "attributeTypes": [],
    "attributeTranslationRules": {},
    "typingRelationTypes": [],
    "typingRelationTranslationRules": {},
    "hierarchyTypes": [],
    "hierarchyTranslationRules": {},
    "relationReificationTypes": [],
    "relationReificationTranslationRules": {},
    "relationReificationExpansions": {},
    "relationReificationPropertySchema": {},
    "relationReificationTypeDependentExpansions": {},
    "relationTypes": [],
    "relationPropertySchema": {},
    "relationTranslationRules": {},
    "ignoredRelationTypes": [
      "ContainsBinding",
      "ContainsArtifact",
      "ImplementedBy"
    ]
  },
  "id": 900002
} as const;
