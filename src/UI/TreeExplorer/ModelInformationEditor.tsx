import React, { Component } from "react";
import { Model } from "../../Domain/ProductLineEngineering/Entities/Model";
import ProjectService from "../../Application/Project/ProjectService";
import { isSplMappingLanguage } from "../../Application/SPL/SplMappingFactory";
 

interface Props { 
  model: Model;
  projectService?: ProjectService;
}

interface State {  
}

export default class ModelInformationEditor extends Component<Props, State> {
  state = {  
  };

  constructor(props: any) {
    super(props);   
  }   

  render() {
    const isSplMapping = isSplMappingLanguage(this.props.model.type);
    const featureModels = this.props.projectService?.getProductLineSelected()?.domainEngineering?.models.filter((candidate) => candidate.elements.some((element) => element.properties?.some((property) => property.name === "Selected"))) || [];
    return (
      <div className=""> 
          <div className="row">
                <div>
                  <div>
                    <label>Name <span style={{ color: 'red' }}>*</span></label>
                    <input
                      type="text"
                      className="form-control"
                      placeholder=""
                      id="inputName"
                      value={this.props.model.name}
                      onChange={this.inputName_onChange}
                    />
                  </div>
                </div>
                <div>
                  <div>
                    <label>Description</label>
                    <textarea
                      className="form-control"
                      placeholder=""
                      id="inputDescription"
                      value={this.props.model.description}
                      onChange={this.inputDescription_onChange}
                    />
                  </div>
                </div>
                <div>
                  <div>
                    <label>Author</label>
                    <input
                      type="text"
                      className="form-control"
                      placeholder="Enter the reference author"
                      id="inputAuthor"
                      value={this.props.model.author}
                      onChange={this.inputAuthor_onChange}
                    />
                  </div>
                </div>
                <div>
                  <div>
                    <label>Source</label>
                    <textarea 
                      className="form-control"
                      placeholder="Enter the reference source"
                      id="inputSource"
                      value={this.props.model.source}
                      onChange={this.inputSource_onChange}
                    />
                  </div>
                </div>
                <div>
                  <div>
                    <label>{isSplMapping ? "Source feature model" : "Source model IDs"}</label>
                    {isSplMapping ? <select className="form-control" value={(this.props.model.sourceModelIds || [])[0] || ""} onChange={this.selectSourceFeatureModel}>
                      <option value="">Select a feature model</option>
                      {featureModels.map((featureModel) => <option key={featureModel.id} value={featureModel.id}>{featureModel.name} ({featureModel.id})</option>)}
                    </select> : <input
                      type="text"
                      className="form-control"
                      placeholder="feature-model-id"
                      id="inputSourceModelIds"
                      value={(this.props.model.sourceModelIds || []).join(", ")}
                      onChange={this.inputSourceModelIds_onChange}
                    />}
                    <small className="form-text text-muted">
                      {isSplMapping ? "The SPL mapping is linked to exactly one feature model." : "Comma-separated IDs."}
                    </small>
                  </div>
                </div>
              </div>
      </div>
    );
  }

  inputName_onChange=(e)=>{
     this.props.model.name=e.target.value;
     this.forceUpdate();
  }

  inputDescription_onChange=(e)=>{
     this.props.model.description=e.target.value;
     this.forceUpdate();
  }

  inputAuthor_onChange=(e)=>{
     this.props.model.author=e.target.value;
     this.forceUpdate();
  }

  inputSource_onChange=(e)=>{
     this.props.model.source=e.target.value;
     this.forceUpdate();
  }

  inputSourceModelIds_onChange=(e)=>{
     this.props.model.sourceModelIds = e.target.value
       .split(",")
       .map((value: string) => value.trim())
       .filter(Boolean);
     this.forceUpdate();
  }

  selectSourceFeatureModel=(e)=>{
    this.props.model.sourceModelIds = e.target.value ? [e.target.value] : [];
    this.forceUpdate();
  }

} 
