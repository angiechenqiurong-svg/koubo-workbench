import Foundation
import Vision
import AppKit
let args=CommandLine.arguments
let directory=URL(fileURLWithPath:args[1])
let interval=Double(args[2]) ?? 0.5
let request=VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages=["zh-Hans","en-US"]
request.usesLanguageCorrection=true
request.customWords=["内心","丰盈","通透","别人","他们","明白","幸福","生活","真正","自己","立场","不同","真理"]
let files=(try FileManager.default.contentsOfDirectory(at:directory,includingPropertiesForKeys:nil)).filter{$0.pathExtension=="jpg"}.sorted{$0.lastPathComponent<$1.lastPathComponent}
for (index,file) in files.enumerated(){autoreleasepool{
    do {
        try VNImageRequestHandler(url:file).perform([request])
        let rows:[[String:Any]]=(request.results ?? []).compactMap{item in
            guard let value=item.topCandidates(1).first else{return nil}
            let b=item.boundingBox
            let text=value.string.applyingTransform(StringTransform("Traditional-Simplified"),reverse:false) ?? value.string
            return ["text":text,"confidence":value.confidence,"x":b.origin.x,"y":b.origin.y,"w":b.width,"h":b.height]
        }
        let bytes=try JSONSerialization.data(withJSONObject:["time":Double(index)*interval,"items":rows])
        print(String(data:bytes,encoding:.utf8)!);fflush(stdout)
    }catch{}
}}
